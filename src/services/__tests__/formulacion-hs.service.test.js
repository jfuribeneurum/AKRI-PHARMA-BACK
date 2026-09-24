import { describe, it, expect, vi, beforeEach } from 'vitest';

// fm.idMedicamento (traído desde HealthSphere) es un id de esa base externa,
// no el id_producto local — son dos espacios de ids completamente distintos.
// getFormulacionHSById() debe resolver el id_producto real vía
// productos.id_medicamento_hs, para que el modal de dispensación pueda
// consultar/descontar el inventario local correcto en vez de usar el id de
// HS como si fuera un id_producto (lo que rompería silenciosamente el
// descuento de stock por lote).
const mockHsConnection = { query: vi.fn(), release: vi.fn() };
vi.mock('../../config/hs-db.js', () => ({
  hsPool: { getConnection: vi.fn(async () => mockHsConnection) }
}));
vi.mock('../../config/db.js', () => ({
  query: vi.fn()
}));

const { query } = await import('../../config/db.js');
const {
  getFormulacionHSById,
  excluirMedicamentoFormulado,
  restaurarMedicamentoExcluido,
  agregarMedicamentoExtra,
  eliminarMedicamentoExtra,
  getExclusionYExtraCounts,
  listFormulacionesHS,
  getDxPorIdMedFormulacion,
  getPrescriptorPorIdFormulacion,
  getTipoDocumentoPacientePorId
} = await import('../formulacion-hs.service.js');

describe('formulacion-hs.service getFormulacionHSById', () => {
  beforeEach(() => {
    mockHsConnection.query.mockReset();
    query.mockReset();
  });

  it('resolves idProductoLocal from productos.id_medicamento_hs for each medicamento', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 1, idPaciente: 1 }]])
      .mockResolvedValueOnce([[
        { id_med_formulacion: 10, idMedicamento: 1, cantidad: 5 },
        { id_med_formulacion: 11, idMedicamento: 2, cantidad: 3 }
      ]]);
    query
      .mockResolvedValueOnce([{ id_medicamento_hs: 1, id_producto: 327 }]) // productos.id_medicamento_hs
      .mockResolvedValueOnce([]) // dispensacion_hs_medicamentos_extra
      .mockResolvedValueOnce([]); // dispensacion_hs_exclusiones

    const result = await getFormulacionHSById(1);

    expect(result.medicamentos[0]).toMatchObject({ idMedicamento: 1, idProductoLocal: 327 });
    expect(result.medicamentos[1]).toMatchObject({ idMedicamento: 2, idProductoLocal: null });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SELECT id_medicamento_hs, id_producto FROM productos WHERE id_medicamento_hs IN/);
    expect(params).toEqual([1, 2]);
  });

  it("when two local productos share the same id_medicamento_hs (two brands of the same generic, e.g. lancetas Accu-Chek vs Glucoquick), resolves to whichever actually has stock in the caller's sede instead of an arbitrary duplicate", async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 1, idPaciente: 1 }]])
      .mockResolvedValueOnce([[
        { id_med_formulacion: 10, idMedicamento: 5, nombre_medicamento: 'LANCETAS PARA GLUCOMETRIA', cantidad: 5 }
      ]]);
    query
      .mockResolvedValueOnce([
        { id_medicamento_hs: 5, id_producto: 416 },
        { id_medicamento_hs: 5, id_producto: 415 }
      ]) // productos.id_medicamento_hs — dos candidatos para el mismo genérico
      .mockResolvedValueOnce([{ id_producto: 415, total: 177600 }]) // stock por sede: solo 415 tiene
      .mockResolvedValueOnce([]) // dispensacion_hs_medicamentos_extra
      .mockResolvedValueOnce([]); // dispensacion_hs_exclusiones

    const result = await getFormulacionHSById(1, 1);

    // idProductoLocal sigue siendo el "ganador" (para trazabilidad/orden),
    // pero idsProductoCandidatos trae ambos — el stock real puede estar
    // repartido entre los dos productos duplicados en la misma sede, y la
    // consulta de stock del modal necesita verlos todos, no solo el ganador.
    expect(result.medicamentos[0]).toMatchObject({
      idMedicamento: 5,
      idProductoLocal: 415,
      idsProductoCandidatos: expect.arrayContaining([415, 416])
    });
    expect(result.medicamentos[0].idsProductoCandidatos).toHaveLength(2);

    const [stockSql, stockParams] = query.mock.calls[1];
    expect(stockSql).toMatch(/a\.id_sede = \?/);
    expect(stockParams).toEqual([416, 415, 1]);
  });

  it('falls back to an exact normalized-text match (nombre_comercial/principio_activo) when idMedicamento has no local link', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 1, idPaciente: 1 }]])
      .mockResolvedValueOnce([[
        { id_med_formulacion: 10, idMedicamento: 999, nombre_medicamento: '  acetaminofen jarabe x 120 ml  ', cantidad: 1 }
      ]]);
    query
      .mockResolvedValueOnce([]) // productos.id_medicamento_hs IN (999) → sin match por id
      .mockResolvedValueOnce([
        { id_producto: 17, nombre_comercial: 'ACETAMINOFEN JARABE X 120 ML', principio_activo: 'ACETAMINOFEN JARABE X 120 ML' }
      ]) // catálogo activo, usado para el fallback de texto
      .mockResolvedValueOnce([]) // dispensacion_hs_medicamentos_extra
      .mockResolvedValueOnce([]); // dispensacion_hs_exclusiones

    const result = await getFormulacionHSById(1);

    expect(result.medicamentos[0]).toMatchObject({ idProductoLocal: 17 });
  });

  it('falls back to a whitespace-stripped match when the HS text and local text differ only in spacing', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 1, idPaciente: 1 }]])
      .mockResolvedValueOnce([[
        { id_med_formulacion: 10, idMedicamento: 999, nombre_medicamento: 'AGUJA INSULINA 32G X4 MM', cantidad: 1 }
      ]]);
    query
      .mockResolvedValueOnce([]) // sin match por id
      .mockResolvedValueOnce([
        { id_producto: 56, nombre_comercial: 'AGUJA INSULINA 32GX4MM', principio_activo: 'AGUJA INSULINA 32GX4MM' }
      ])
      .mockResolvedValueOnce([]) // extras
      .mockResolvedValueOnce([]); // exclusiones

    const result = await getFormulacionHSById(1);

    expect(result.medicamentos[0]).toMatchObject({ idProductoLocal: 56 });
  });

  it('leaves idProductoLocal null (not an arbitrary guess) when neither id nor text match anything in the local catalog', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 1, idPaciente: 1 }]])
      .mockResolvedValueOnce([[
        { id_med_formulacion: 10, idMedicamento: 999, nombre_medicamento: 'MEDICAMENTO SIN EQUIVALENTE LOCAL', cantidad: 1 }
      ]]);
    query
      .mockResolvedValueOnce([]) // sin match por id
      .mockResolvedValueOnce([
        { id_producto: 17, nombre_comercial: 'ACETAMINOFEN JARABE X 120 ML', principio_activo: 'ACETAMINOFEN JARABE X 120 ML' }
      ]) // catálogo activo, ninguno coincide
      .mockResolvedValueOnce([]) // extras
      .mockResolvedValueOnce([]); // exclusiones

    const result = await getFormulacionHSById(1);

    expect(result.medicamentos[0]).toMatchObject({ idProductoLocal: null });
  });

  it('does not query productos.id_medicamento_hs when there are no medicamentos with an idMedicamento', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 1, idPaciente: 1 }]])
      .mockResolvedValueOnce([[]]);
    query
      .mockResolvedValueOnce([]) // dispensacion_hs_medicamentos_extra
      .mockResolvedValueOnce([]); // dispensacion_hs_exclusiones

    const result = await getFormulacionHSById(1);

    // Ningún query() debe pedir productos.id_medicamento_hs (no hay ids que resolver) —
    // solo se consultan extras/exclusiones locales, que siempre corren.
    expect(query.mock.calls.some(([sql]) => sql.includes('id_medicamento_hs'))).toBe(false);
    expect(result.medicamentos).toEqual([]);
  });

  it('returns null without querying medicamentos when the formulación does not exist', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[]]);

    const result = await getFormulacionHSById(999);

    expect(result).toBeNull();
    expect(mockHsConnection.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('filters out medicamentos excluded locally via dispensacion_hs_exclusiones', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 1, idPaciente: 1 }]])
      .mockResolvedValueOnce([[
        { id_med_formulacion: 10, idMedicamento: null, cantidad: 5 },
        { id_med_formulacion: 11, idMedicamento: null, cantidad: 3 }
      ]]);
    query
      .mockResolvedValueOnce([]) // dispensacion_hs_medicamentos_extra
      .mockResolvedValueOnce([{ id_med_formulacion_hs: 10 }]); // dispensacion_hs_exclusiones

    const result = await getFormulacionHSById(1);

    expect(result.medicamentos).toHaveLength(1);
    expect(result.medicamentos[0]).toMatchObject({ id_med_formulacion: 11 });
  });

  it('merges manually added medicamentos with an offset id and idProductoLocal from the extra row', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 1, idPaciente: 1 }]])
      .mockResolvedValueOnce([[]]);
    query
      .mockResolvedValueOnce([{
        id: 5, id_producto: 42, nombre_medicamento: 'IBUPROFENO 400MG', presentacion: 'Tableta',
        via_administracion: 'Oral', cantidad: 10, diagnostico: null, observaciones: null
      }])
      .mockResolvedValueOnce([]); // dispensacion_hs_exclusiones

    const result = await getFormulacionHSById(1);

    expect(result.medicamentos).toEqual([
      expect.objectContaining({
        id_med_formulacion: 900000005,
        idProductoLocal: 42,
        esManual: true,
        idMedicamentoExtra: 5,
        nombre_medicamento: 'IBUPROFENO 400MG'
      })
    ]);
  });
});

describe('excluirMedicamentoFormulado / restaurarMedicamentoExcluido', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
  });

  it('inserts (INSERT IGNORE) an exclusion row scoped to the formulación and medicamento, and traces it', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[{ Id: 7 }]]); // assertFormulacionExiste
    query
      .mockResolvedValueOnce({ affectedRows: 1 }) // INSERT IGNORE exclusiones
      .mockResolvedValueOnce({}); // recordProcessTrace

    const result = await excluirMedicamentoFormulado(7, 11, 'ABACAVIR 300 MG', 99, 'fuera de stock', 3);

    expect(result).toEqual({ id_formulacion_hs: 7, id_med_formulacion_hs: 11, excluido: true });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT IGNORE INTO dispensacion_hs_exclusiones/);
    expect(params).toEqual([7, 11, 'ABACAVIR 300 MG', 'fuera de stock', 99]);
    const [traceSql, traceParams] = query.mock.calls[1];
    expect(traceSql).toMatch(/INSERT INTO procesos_terminados_trazabilidad/);
    expect(traceParams).toEqual(expect.arrayContaining(['EXCLUIR_MEDICAMENTO_FORMULACION']));
  });

  it('rejects with 404 when the formulación does not exist in HealthSphere', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[]]); // sin fila

    await expect(excluirMedicamentoFormulado(999, 11, 'X', 1))
      .rejects.toMatchObject({ status: 404 });
    expect(query).not.toHaveBeenCalled();
  });

  it('restaurarMedicamentoExcluido deletes the exclusion row for that formulación/medicamento and traces it', async () => {
    query
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({});

    const result = await restaurarMedicamentoExcluido(7, 11, 99, 3);

    expect(result).toEqual({ id_formulacion_hs: 7, id_med_formulacion_hs: 11, excluido: false });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM dispensacion_hs_exclusiones/);
    expect(params).toEqual([7, 11]);
    expect(query.mock.calls[1][0]).toMatch(/INSERT INTO procesos_terminados_trazabilidad/);
  });
});

describe('agregarMedicamentoExtra / eliminarMedicamentoExtra', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
  });

  it('rejects with 404 when the formulación does not exist in HealthSphere', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[]]);

    await expect(agregarMedicamentoExtra(999, { id_producto: 42, cantidad: 2 }, 1))
      .rejects.toMatchObject({ status: 404 });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects with 404 when id_producto does not exist (or is inactive) in the Maestro', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[{ Id: 7 }]]); // assertFormulacionExiste
    query.mockResolvedValueOnce([]); // SELECT nombre_comercial → sin fila

    await expect(agregarMedicamentoExtra(7, { id_producto: 999, cantidad: 2 }, 1))
      .rejects.toMatchObject({ status: 404 });
  });

  it("inserts using the product's own nombre_comercial from the Maestro, never client-supplied text, and traces it", async () => {
    mockHsConnection.query.mockResolvedValueOnce([[{ Id: 7 }]]); // assertFormulacionExiste
    query
      .mockResolvedValueOnce([{ nombre_comercial: 'IBUPROFENO 400 MG' }]) // SELECT productos
      .mockResolvedValueOnce([]) // SELECT dispensacion_hs_medicamentos_extra (sin duplicado activo)
      .mockResolvedValueOnce({ insertId: 123 }) // INSERT
      .mockResolvedValueOnce({}); // recordProcessTrace

    const result = await agregarMedicamentoExtra(7, {
      id_producto: 42, presentacion: 'Tableta', via_administracion: 'Oral', cantidad: 3
    }, 1);

    expect(result).toEqual({ id_med_formulacion: 900000123, esManual: true });
    const [sql, params] = query.mock.calls[2];
    expect(sql).toMatch(/INSERT INTO dispensacion_hs_medicamentos_extra/);
    expect(params).toEqual([7, 42, 'IBUPROFENO 400 MG', 'Tableta', 'Oral', 3, null, null, 1]);
    expect(query.mock.calls[3][0]).toMatch(/INSERT INTO procesos_terminados_trazabilidad/);
  });

  it('rejects with 409 instead of inserting a duplicate when the same producto is already active in this formulación (reintentos por el bug de stock que no cargaba de una)', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[{ Id: 7 }]]); // assertFormulacionExiste
    query
      .mockResolvedValueOnce([{ nombre_comercial: 'GLIFORMIN' }]) // SELECT productos
      .mockResolvedValueOnce([{ id: 41 }]); // ya existe un extra activo con este id_producto

    await expect(agregarMedicamentoExtra(7, { id_producto: 451, cantidad: 30 }, 1))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('GLIFORMIN') });

    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO dispensacion_hs_medicamentos_extra'))).toBe(false);
  });

  it('eliminarMedicamentoExtra soft-deletes (activo = 0) an existing manual medicamento and traces it', async () => {
    query
      .mockResolvedValueOnce([{ id: 5, id_formulacion_hs: 7, nombre_medicamento: 'IBUPROFENO 400 MG' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce({});

    const result = await eliminarMedicamentoExtra(5, 1);

    expect(result).toEqual({ id: 5, eliminado: true });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/UPDATE dispensacion_hs_medicamentos_extra SET activo = 0/);
    expect(params).toEqual([5]);
    expect(query.mock.calls[2][0]).toMatch(/INSERT INTO procesos_terminados_trazabilidad/);
  });

  it('eliminarMedicamentoExtra throws 404 when the medicamento does not exist or is already inactive', async () => {
    query.mockResolvedValueOnce([]);

    await expect(eliminarMedicamentoExtra(999, 1)).rejects.toMatchObject({ status: 404 });
  });
});

describe('getExclusionYExtraCounts (corrige total_medicamentos para el estado agregado y su filtro)', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('returns zero for every id when there are no exclusions or extras', async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await getExclusionYExtraCounts([1, 2]);

    expect(result).toEqual({ 1: { excluidos: 0, extras: 0 }, 2: { excluidos: 0, extras: 0 } });
  });

  it('fills in counts only for the formulaciones that actually have exclusions/extras, leaving the rest at zero', async () => {
    query
      .mockResolvedValueOnce([{ id_formulacion_hs: 1, n: 2 }])
      .mockResolvedValueOnce([{ id_formulacion_hs: 2, n: 1 }]);

    const result = await getExclusionYExtraCounts([1, 2, 3]);

    expect(result).toEqual({
      1: { excluidos: 2, extras: 0 },
      2: { excluidos: 0, extras: 1 },
      3: { excluidos: 0, extras: 0 }
    });
  });

  it('short-circuits without querying when given an empty id list', async () => {
    const result = await getExclusionYExtraCounts([]);

    expect(result).toEqual({});
    expect(query).not.toHaveBeenCalled();
  });
});

// HealthSphere es una base externa de solo lectura (336k+241k filas) sin
// índice en tipo/fechaFormulacion — el listado sin texto de búsqueda medía
// ~3.2s porque el JOIN con paciente/atención corría ANTES de ordenar/paginar.
// Sin búsqueda, el filtro completo vive en suhc_new_tbl_formulacion sola, así
// que se resuelve ahí primero (filtra+ordena+pagina) y el JOIN corre solo
// sobre esa página ya acotada, en vez de sobre todo el universo.
describe('formulacion-hs.service listFormulacionesHS (optimización del listado sin búsqueda)', () => {
  beforeEach(() => {
    mockHsConnection.query.mockReset();
  });

  it('without a search term, resolves the page via a subquery on suhc_new_tbl_formulacion alone before joining paciente/atención', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 1, idPaciente: 9, fechaFormulacion: '2026-01-01', total_medicamentos: 2 }]])
      .mockResolvedValueOnce([[{ total: 1 }]]);

    const result = await listFormulacionesHS({ page: 1, limit: 30 });

    const [listSql, listParams] = mockHsConnection.query.mock.calls[0];
    expect(listSql).toMatch(/FROM \(\s*SELECT f\.Id AS id_formulacion.*FROM suhc_new_tbl_formulacion f/s);
    expect(listSql).toMatch(/\) f\s*INNER JOIN tblpaciente p ON p\.id = f\.idPaciente/);
    expect(listParams).toEqual([30, 0]);

    const [countSql, countParams] = mockHsConnection.query.mock.calls[1];
    // El COUNT no debe tocar tblpaciente ni atención cuando no hay búsqueda —
    // el filtro (tipo, fechas) vive solo en f.
    expect(countSql).not.toMatch(/tblpaciente/);
    expect(countSql).not.toMatch(/suhc_new_tbl_atencion/);
    expect(countParams).toEqual([]);

    expect(result.data).toEqual([{ id_formulacion: 1, idPaciente: 9, fechaFormulacion: '2026-01-01', total_medicamentos: 2 }]);
    expect(result.total).toBe(1);
  });

  it('threads fechaDesde/fechaHasta into the inner subquery filter, not the outer join', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 0 }]]);

    await listFormulacionesHS({ page: 2, limit: 10, fechaDesde: '2026-01-01', fechaHasta: '2026-01-31' });

    const [listSql, listParams] = mockHsConnection.query.mock.calls[0];
    expect(listSql).toMatch(/f\.fechaFormulacion >= \?/);
    expect(listSql).toMatch(/f\.fechaFormulacion <= \?/);
    expect(listParams).toEqual(['2026-01-01', '2026-01-31', 10, 10]); // offset = (2-1)*10

    const [, countParams] = mockHsConnection.query.mock.calls[1];
    expect(countParams).toEqual(['2026-01-01', '2026-01-31']);
  });

  it('with a search term, keeps the join-first STRAIGHT_JOIN form instead (search spans paciente/atención, cannot be resolved from f alone)', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 5, documento_paciente: '123' }]])
      .mockResolvedValueOnce([[{ total: 1 }]]);

    const result = await listFormulacionesHS({ search: '123', page: 1, limit: 30 });

    const [listSql, listParams] = mockHsConnection.query.mock.calls[0];
    expect(listSql).toMatch(/SELECT STRAIGHT_JOIN/);
    expect(listSql).toMatch(/p\.documento LIKE \?/);
    expect(listParams).toEqual(['%123%', '%123%', '%123%', '%123%', '%123%', 30, 0]);

    const [countSql] = mockHsConnection.query.mock.calls[1];
    expect(countSql).toMatch(/INNER JOIN tblpaciente p/);
    expect(result.data).toEqual([{ id_formulacion: 5, documento_paciente: '123' }]);
  });
});

// Para el informe RIPS (archivo AM): varios campos (unidad de dosificación,
// forma farmacéutica, unidad mínima de dispensación, temporalidad) solo
// existen en HealthSphere. HS NO tiene catálogo para traducir
// idFormaFarmaceutica/idUnidadCalculo a texto en algunos casos, ni para los
// códigos de unidad de posologiaTipo/temporalidadTipo — estas pruebas fijan
// que cuando no hay texto real, se expone un código crudo en vez de inventar
// una traducción.
describe('formulacion-hs.service getDxPorIdMedFormulacion', () => {
  beforeEach(() => {
    mockHsConnection.query.mockReset();
  });

  it('usa fm.unidadDosificacion como unidad mínima cuando el medicamento NO tiene cálculo (conCalculo=0), y resuelve forma farmacéutica desde el catálogo real', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[
      { Id: 1, dx: 'E109-Diabetes', unidadDosificacion: 'TABLETA', posologiaTipoCantidad: 8, posologiaTipo: 0, temporalidad: 30, temporalidadTipo: 1, concentracion: '20 MG', conCalculo: 0, idUnidadCalculo: null, forma_farmaceutica: 'TABLETA RECUBIERTA', unidad_calculo: null }
    ]]);

    const result = await getDxPorIdMedFormulacion([1]);

    const [sql] = mockHsConnection.query.mock.calls[0];
    expect(sql).toContain('suhc_new_tbl_maestrasdetalle');
    expect(sql).toContain('idMaestra = 1');
    expect(result[1].unidad_dosificacion_hs).toBe('TABLETA');
    expect(result[1].forma_farmaceutica_hs).toBe('TABLETA RECUBIERTA');
    expect(result[1].unidad_minima_dispensacion).toBe('TABLETA');
  });

  it('arma la temporalidad como "cada X horas durante Y días", igual al PDF de la formulación', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[
      { Id: 1, dx: null, unidadDosificacion: 'TABLETA', posologiaTipoCantidad: 6, posologiaTipo: 0, temporalidad: 2, temporalidadTipo: 1, concentracion: null, conCalculo: 0, idUnidadCalculo: null, forma_farmaceutica: null, unidad_calculo: null }
    ]]);

    const result = await getDxPorIdMedFormulacion([1]);

    expect(result[1].temporalidad_hs).toBe('cada 6 horas durante 2 días');
  });

  it('arma la temporalidad con semanas/meses cuando posologiaTipo/temporalidadTipo lo indican', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[
      { Id: 4, dx: null, unidadDosificacion: 'PEN', posologiaTipoCantidad: 1, posologiaTipo: 2, temporalidad: 1, temporalidadTipo: 3, concentracion: null, conCalculo: 0, idUnidadCalculo: null, forma_farmaceutica: null, unidad_calculo: null }
    ]]);

    const result = await getDxPorIdMedFormulacion([4]);

    expect(result[4].temporalidad_hs).toBe('cada 1 semanas durante 1 meses');
  });

  it('resuelve la unidad de cálculo real (ej. "PEN"/"VIAL") cuando el medicamento SÍ tiene cálculo, en vez de un código crudo', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[
      { Id: 2, dx: null, unidadDosificacion: 'AMPOLLA', posologiaTipoCantidad: 24, posologiaTipo: 0, temporalidad: 1, temporalidadTipo: 1, concentracion: '1000 UI', conCalculo: 1, idUnidadCalculo: 114, forma_farmaceutica: 'SOLUCION INYECTABLE', unidad_calculo: 'VIAL' }
    ]]);

    const result = await getDxPorIdMedFormulacion([2]);

    expect(result[2].unidad_minima_dispensacion).toBe('VIAL');
    // La unidad de dosificación normal (texto real) se sigue exponiendo
    // aparte — la unidad de cálculo es SOLO para la unidad mínima.
    expect(result[2].unidad_dosificacion_hs).toBe('AMPOLLA');
  });

  it('si la unidad de cálculo no resuelve en el catálogo, cae a un código crudo en vez de dejarlo vacío', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[
      { Id: 3, dx: null, unidadDosificacion: 'AMPOLLA', posologiaTipoCantidad: 24, posologiaTipo: 0, temporalidad: 1, temporalidadTipo: 1, concentracion: '1000 UI', conCalculo: 1, idUnidadCalculo: 999, forma_farmaceutica: null, unidad_calculo: null }
    ]]);

    const result = await getDxPorIdMedFormulacion([3]);

    expect(result[3].unidad_minima_dispensacion).toBe('COD-999');
  });

  it('sin ids, no consulta HealthSphere', async () => {
    const result = await getDxPorIdMedFormulacion([]);
    expect(mockHsConnection.query).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});

// El médico prescriptor vive a nivel de FORMULACIÓN (idEspecialista →
// suhc_new_tbl_usuario), no por cada medicamento — todos los renglones de
// una misma fórmula comparten el mismo prescriptor.
describe('formulacion-hs.service getPrescriptorPorIdFormulacion', () => {
  beforeEach(() => {
    mockHsConnection.query.mockReset();
  });

  it('resuelve tipo (texto real, ej. "CC") y número de documento (cédula) del médico vía idEspecialista, aparte del registro profesional', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[
      { Id: 347537, tipo_documento: 'CC', documento: '71717384', registro_profesional: '71717384' }
    ]]);

    const result = await getPrescriptorPorIdFormulacion([347537]);

    const [sql, params] = mockHsConnection.query.mock.calls[0];
    expect(sql).toContain('f.idEspecialista');
    expect(sql).toContain('u.documento');
    expect(sql).toContain('u.registro_profesional');
    expect(sql).toContain('tbl_tiposidentificacion');
    expect(params).toEqual([347537]);
    expect(result[347537]).toEqual({
      tipo_documento_medico: 'CC',
      numero_documento_medico: '71717384',
      registro_profesional_medico: '71717384'
    });
  });

  // El registro profesional no siempre coincide con la cédula (ej. formatos
  // "15052/09", "052009-14") — confirma que ambos se exponen por separado.
  it('cuando el registro profesional difiere de la cédula, expone ambos por separado', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[
      { Id: 500, tipo_documento: 'CC', documento: '74378119', registro_profesional: '15052/09' }
    ]]);

    const result = await getPrescriptorPorIdFormulacion([500]);

    expect(result[500].numero_documento_medico).toBe('74378119');
    expect(result[500].registro_profesional_medico).toBe('15052/09');
  });

  it('formulaciones sin especialista enlazado (idEspecialista=0) quedan en null, no inventadas', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[
      { Id: 21, tipo_documento: null, documento: null, registro_profesional: null }
    ]]);

    const result = await getPrescriptorPorIdFormulacion([21]);

    expect(result[21]).toEqual({ tipo_documento_medico: null, numero_documento_medico: null, registro_profesional_medico: null });
  });

  it('sin ids, no consulta HealthSphere', async () => {
    const result = await getPrescriptorPorIdFormulacion([]);
    expect(mockHsConnection.query).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});

// "Tipo ID" del paciente para RIPS: dispensacion_hs_control (local) ya trae
// documento/nombre del paciente, pero el tipo de documento solo existe en
// HealthSphere (tblpaciente.tipo_documento, código numérico) — se resuelve
// contra el catálogo real tbl_tiposidentificacion (1=CC, 5=TI, etc.), no
// contra un mapa inventado en este código.
describe('formulacion-hs.service getTipoDocumentoPacientePorId', () => {
  beforeEach(() => {
    mockHsConnection.query.mockReset();
  });

  it('resuelve el tipo de documento del paciente contra tbl_tiposidentificacion', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[
      { id: 25446, tipo_documento: 'CC' }
    ]]);

    const result = await getTipoDocumentoPacientePorId([25446]);

    const [sql, params] = mockHsConnection.query.mock.calls[0];
    expect(sql).toContain('tblpaciente');
    expect(sql).toContain('tbl_tiposidentificacion');
    expect(params).toEqual([25446]);
    expect(result[25446]).toBe('CC');
  });

  it('paciente sin tipo de documento resuelto queda en null, no inventado', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[
      { id: 999999, tipo_documento: null }
    ]]);

    const result = await getTipoDocumentoPacientePorId([999999]);

    expect(result[999999]).toBeNull();
  });

  it('sin ids, no consulta HealthSphere', async () => {
    const result = await getTipoDocumentoPacientePorId([]);
    expect(mockHsConnection.query).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});
