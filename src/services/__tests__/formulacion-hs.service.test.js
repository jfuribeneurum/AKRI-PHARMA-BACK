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
  listFormulacionesHS
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
