import { describe, it, expect, vi, beforeEach } from 'vitest';

// listProducts() used to require productos.sku and .nombre_comercial to be
// non-empty just to appear in Maestro MX at all — hiding any product created
// from a HealthSphere medicamento link (id_medicamento_hs) without someone
// also typing a commercial name/sku by hand. The list must show every
// product, sourcing its display name from the linked HS medicamento when
// nombre_comercial is blank, and the search box must also match
// id_medicamento_hs (not just nombre_comercial/sku/principio_activo).
vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));

const mockHsConnection = { query: vi.fn(), release: vi.fn() };
vi.mock('../../config/hs-db.js', () => ({
  hsPool: { getConnection: vi.fn(async () => mockHsConnection) }
}));

const { query } = await import('../../config/db.js');
const { listProducts } = await import('../product.service.js');

describe('product.service listProducts', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
  });

  it('does not require sku/nombre_comercial to be non-empty to list a product', async () => {
    query.mockResolvedValueOnce([]);
    await listProducts();
    const [sql] = query.mock.calls[0];
    expect(sql).not.toMatch(/p\.sku IS NOT NULL/);
    expect(sql).not.toMatch(/p\.nombre_comercial IS NOT NULL/);
  });

  it('includes id_medicamento_hs in the search condition', async () => {
    query.mockResolvedValueOnce([]);
    await listProducts('abc');
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/p\.id_medicamento_hs LIKE \?/);
  });

  it('enriches products with the linked HealthSphere medicamento name', async () => {
    query.mockResolvedValueOnce([
      { id_producto: 1, id_medicamento_hs: 1, nombre_comercial: '' },
      { id_producto: 2, id_medicamento_hs: null, nombre_comercial: 'Ibuprofeno' }
    ]);
    mockHsConnection.query.mockResolvedValueOnce([
      [{ id: 1, nombre: 'ABACAVIR 300 MG TABLETA RECUBIERTA' }]
    ]);

    const result = await listProducts();

    expect(result[0].nombre_medicamento_hs).toBe('ABACAVIR 300 MG TABLETA RECUBIERTA');
    expect(result[1].nombre_medicamento_hs).toBeNull();
  });

  it('does not query HealthSphere when no product has id_medicamento_hs set', async () => {
    query.mockResolvedValueOnce([{ id_producto: 2, id_medicamento_hs: null, nombre_comercial: 'Ibuprofeno' }]);
    await listProducts();
    expect(mockHsConnection.query).not.toHaveBeenCalled();
  });
});
