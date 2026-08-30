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
  eliminarMedicamentoExtra
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
  });

  it('inserts (INSERT IGNORE) an exclusion row scoped to the formulación and medicamento', async () => {
    query.mockResolvedValueOnce({ affectedRows: 1 });

    const result = await excluirMedicamentoFormulado(7, 11, 'ABACAVIR 300 MG', 99, 'fuera de stock');

    expect(result).toEqual({ id_formulacion_hs: 7, id_med_formulacion_hs: 11, excluido: true });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT IGNORE INTO dispensacion_hs_exclusiones/);
    expect(params).toEqual([7, 11, 'ABACAVIR 300 MG', 'fuera de stock', 99]);
  });

  it('restaurarMedicamentoExcluido deletes the exclusion row for that formulación/medicamento', async () => {
    query.mockResolvedValueOnce({ affectedRows: 1 });

    const result = await restaurarMedicamentoExcluido(7, 11);

    expect(result).toEqual({ id_formulacion_hs: 7, id_med_formulacion_hs: 11, excluido: false });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM dispensacion_hs_exclusiones/);
    expect(params).toEqual([7, 11]);
  });
});

describe('agregarMedicamentoExtra / eliminarMedicamentoExtra', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('rejects with 404 when id_producto does not exist (or is inactive) in the Maestro', async () => {
    query.mockResolvedValueOnce([]); // SELECT nombre_comercial → sin fila

    await expect(agregarMedicamentoExtra(7, { id_producto: 999, cantidad: 2 }, 1))
      .rejects.toMatchObject({ status: 404 });
  });

  it("inserts using the product's own nombre_comercial from the Maestro, never client-supplied text", async () => {
    query
      .mockResolvedValueOnce([{ nombre_comercial: 'IBUPROFENO 400 MG' }]) // SELECT productos
      .mockResolvedValueOnce({ insertId: 123 }); // INSERT

    const result = await agregarMedicamentoExtra(7, {
      id_producto: 42, presentacion: 'Tableta', via_administracion: 'Oral', cantidad: 3
    }, 1);

    expect(result).toEqual({ id_med_formulacion: 900000123, esManual: true });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO dispensacion_hs_medicamentos_extra/);
    expect(params).toEqual([7, 42, 'IBUPROFENO 400 MG', 'Tableta', 'Oral', 3, null, null, 1]);
  });

  it('eliminarMedicamentoExtra soft-deletes (activo = 0) an existing manual medicamento', async () => {
    query
      .mockResolvedValueOnce([{ id: 5 }])
      .mockResolvedValueOnce({ affectedRows: 1 });

    const result = await eliminarMedicamentoExtra(5, 1);

    expect(result).toEqual({ id: 5, eliminado: true });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/UPDATE dispensacion_hs_medicamentos_extra SET activo = 0/);
    expect(params).toEqual([5]);
  });

  it('eliminarMedicamentoExtra throws 404 when the medicamento does not exist or is already inactive', async () => {
    query.mockResolvedValueOnce([]);

    await expect(eliminarMedicamentoExtra(999, 1)).rejects.toMatchObject({ status: 404 });
  });
});
