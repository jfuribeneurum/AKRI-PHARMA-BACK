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
const { getFormulacionHSById } = await import('../formulacion-hs.service.js');

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
    query.mockResolvedValueOnce([{ id_medicamento_hs: 1, id_producto: 327 }]);

    const result = await getFormulacionHSById(1);

    expect(result.medicamentos[0]).toMatchObject({ idMedicamento: 1, idProductoLocal: 327 });
    expect(result.medicamentos[1]).toMatchObject({ idMedicamento: 2, idProductoLocal: null });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SELECT id_medicamento_hs, id_producto FROM productos WHERE id_medicamento_hs IN/);
    expect(params).toEqual([1, 2]);
  });

  it('does not query the local database when there are no medicamentos with an idMedicamento', async () => {
    mockHsConnection.query
      .mockResolvedValueOnce([[{ id_formulacion: 1, idPaciente: 1 }]])
      .mockResolvedValueOnce([[]]);

    const result = await getFormulacionHSById(1);

    expect(query).not.toHaveBeenCalled();
    expect(result.medicamentos).toEqual([]);
  });

  it('returns null without querying medicamentos when the formulación does not exist', async () => {
    mockHsConnection.query.mockResolvedValueOnce([[]]);

    const result = await getFormulacionHSById(999);

    expect(result).toBeNull();
    expect(mockHsConnection.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
});
