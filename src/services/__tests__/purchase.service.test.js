import { describe, it, expect, vi, beforeEach } from 'vitest';

// GET /purchases/warehouses used to return every active almacén system-wide
// regardless of the requesting user's sede, letting the PO warehouse picker
// show warehouses the user has no business seeing.
vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));

const { query, withTransaction } = await import('../../config/db.js');
const { listWarehousesForPO, receivePurchaseOrder } = await import('../purchase.service.js');

describe('purchase.service listWarehousesForPO', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([]);
  });

  it('scopes to the given id_sede', async () => {
    await listWarehousesForPO(5);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/s\.id_sede = \?/);
    expect(params).toEqual([5, 5]);
  });

  it('is unscoped when no id_sede is given', async () => {
    await listWarehousesForPO();
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([null, null]);
  });
});

// receivePurchaseOrder used to trust payload.id_almacen blindly: the PO
// warehouse dropdown is now scoped client-side, but nothing stopped someone
// hitting the API directly with an id_almacen from a different sede.
describe('purchase.service receivePurchaseOrder', () => {
  beforeEach(() => {
    query.mockReset();
    withTransaction.mockReset();
  });

  function mockConnection(routes) {
    return {
      execute: vi.fn(async (sql, params) => {
        for (const [match, result] of routes) {
          if (sql.includes(match)) {
            return typeof result === 'function' ? result(params) : result;
          }
        }
        throw new Error(`Unmocked SQL in test: ${sql}`);
      })
    };
  }

  it('rejects an id_almacen that belongs to a different sede than the order', async () => {
    query.mockResolvedValueOnce([
      { id_sede: 1, codigo: 'C', nombre: 'Central', es_principal: 1, activo: 1 }
    ]);

    withTransaction.mockImplementation(async (cb) => {
      const connection = mockConnection([
        ['FROM ordenes_compra WHERE id_oc', [[{ id_oc: 10, id_sede: 1 }]]],
        ['FROM almacenes WHERE id_almacen', [[{ id_sede: 2 }]]]
      ]);
      return cb(connection);
    });

    await expect(
      receivePurchaseOrder(10, { id_almacen: 99, items: [] }, { id_sede: 1, sub: 1 })
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects an id_almacen that does not exist or is inactive', async () => {
    query.mockResolvedValueOnce([
      { id_sede: 1, codigo: 'C', nombre: 'Central', es_principal: 1, activo: 1 }
    ]);

    withTransaction.mockImplementation(async (cb) => {
      const connection = mockConnection([
        ['FROM ordenes_compra WHERE id_oc', [[{ id_oc: 10, id_sede: 1 }]]],
        ['FROM almacenes WHERE id_almacen', [[]]]
      ]);
      return cb(connection);
    });

    await expect(
      receivePurchaseOrder(10, { id_almacen: 999, items: [] }, { id_sede: 1, sub: 1 })
    ).rejects.toMatchObject({ status: 403 });
  });
});
