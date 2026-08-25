import { describe, it, expect, vi, beforeEach } from 'vitest';

// listStock/getInventoryLookups used to return every warehouse's stock
// unscoped, regardless of who was asking — the active-almacén selector
// feature depends on these actually filtering by the caller's session.
vi.mock('../../config/db.js', () => ({
  query: vi.fn()
}));

const { query } = await import('../../config/db.js');
const { listStock, getInventoryLookups } = await import('../inventory.service.js');

describe('inventory.service warehouse scoping', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([]);
  });

  it('listStock filters by id_almacen when provided', async () => {
    await listStock('abacavir', 10);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/e\.id_almacen = \?/);
    expect(params.at(-2)).toBe(10);
    expect(params.at(-1)).toBe(10);
  });

  it('listStock is unscoped (passes null) when no almacén is given', async () => {
    await listStock('abacavir');
    const [, params] = query.mock.calls[0];
    expect(params.at(-2)).toBeNull();
    expect(params.at(-1)).toBeNull();
  });

  it('getInventoryLookups scopes both almacenes and ubicaciones by id_sede when provided', async () => {
    await getInventoryLookups(5);
    const [almacenesSql, almacenesParams] = query.mock.calls[0];
    const [ubicacionesSql, ubicacionesParams] = query.mock.calls[1];

    expect(almacenesSql).toMatch(/id_sede = \?/);
    expect(almacenesParams).toEqual([5, 5]);

    expect(ubicacionesSql).toMatch(/a\.id_sede = \?/);
    expect(ubicacionesParams).toEqual([5, 5]);
  });

  it('getInventoryLookups is unscoped when no id_sede is given', async () => {
    await getInventoryLookups();
    const [, almacenesParams] = query.mock.calls[0];
    expect(almacenesParams).toEqual([null, null]);
  });
});
