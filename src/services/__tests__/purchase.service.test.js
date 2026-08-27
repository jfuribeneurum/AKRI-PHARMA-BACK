import { describe, it, expect, vi, beforeEach } from 'vitest';

// GET /purchases/warehouses used to return every active almacén system-wide
// regardless of the requesting user's sede, letting the PO warehouse picker
// show warehouses the user has no business seeing.
vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));
vi.mock('../traceability.service.js', () => ({
  recordProcessTrace: vi.fn()
}));

const { query, withTransaction } = await import('../../config/db.js');
const { recordProcessTrace } = await import('../traceability.service.js');
const { listWarehousesForPO, receivePurchaseOrder, getPurchaseOrder, approvePurchaseOrder, cancelPurchaseOrder } = await import('../purchase.service.js');

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

// El documento/PDF de la orden de compra necesita el teléfono de la sede y
// el nombre de quien la creó/aprobó — getPurchaseOrder debe traerlos
// resueltos (no solo los ids crudos de la tabla).
describe('purchase.service getPurchaseOrder', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('enriches the header with sede_telefono and the resolved creador/aprobador names', async () => {
    query
      .mockResolvedValueOnce([{ id_oc: 7, numero_oc: 'OC-0000007', creado_por_nombre: 'Ana Ríos', aprobado_por_nombre: null, sede_telefono: '6010000000' }])
      .mockResolvedValueOnce([]);

    const oc = await getPurchaseOrder(7);

    expect(oc).toMatchObject({ creado_por_nombre: 'Ana Ríos', aprobado_por_nombre: null, sede_telefono: '6010000000' });
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/s\.telefono AS sede_telefono/);
    expect(sql).toMatch(/uc\.nombre_completo AS creado_por_nombre/);
    expect(sql).toMatch(/ua\.nombre_completo AS aprobado_por_nombre/);
  });
});

// approvePurchaseOrder marcaba estado='aprobada' pero nunca llenaba
// aprobado_por/fecha_aprobacion pese a que la tabla los tiene — sin esto
// el documento de la orden nunca puede mostrar quién la aprobó.
describe('purchase.service approvePurchaseOrder', () => {
  beforeEach(() => {
    query.mockReset();
    recordProcessTrace.mockReset();
  });

  it('records who approved the order', async () => {
    query
      .mockResolvedValueOnce([{ id_sede: 1, es_principal: 1, activo: 1 }])
      .mockResolvedValueOnce([{ id_oc: 10, numero_oc: 'OC-0000010', estado: 'enviada' }])
      .mockResolvedValueOnce([]);

    await approvePurchaseOrder(10, { id_sede: 1, sub: 42 });

    const updateCall = query.mock.calls.find(([sql]) => /UPDATE ordenes_compra SET estado = 'aprobada'/.test(sql));
    expect(updateCall[0]).toMatch(/aprobado_por = \?, fecha_aprobacion = NOW\(\)/);
    expect(updateCall[1]).toEqual([42, 10]);
  });

  it('leaves an audit trace of the approval', async () => {
    query
      .mockResolvedValueOnce([{ id_sede: 1, es_principal: 1, activo: 1 }])
      .mockResolvedValueOnce([{ id_oc: 10, numero_oc: 'OC-0000010', estado: 'enviada' }])
      .mockResolvedValueOnce([]);

    await approvePurchaseOrder(10, { id_sede: 1, sub: 42 });

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [, entry] = recordProcessTrace.mock.calls[0];
    expect(entry).toMatchObject({
      proceso: 'COMPRAS', subproceso: 'ORDEN_COMPRA_APROBACION',
      id_sede: 1, id_usuario: 42, referencia_tipo: 'ORDEN_COMPRA', referencia_id: 10
    });
  });
});

// cancelPurchaseOrder tenía el mismo hueco: cambiaba el estado pero nunca
// dejaba rastro de quién canceló la orden.
describe('purchase.service cancelPurchaseOrder', () => {
  beforeEach(() => {
    query.mockReset();
    recordProcessTrace.mockReset();
  });

  it('leaves an audit trace of the cancellation', async () => {
    query
      .mockResolvedValueOnce([{ id_sede: 1, es_principal: 1, activo: 1 }])
      .mockResolvedValueOnce([{ id_oc: 11, numero_oc: 'OC-0000011', estado: 'enviada' }])
      .mockResolvedValueOnce([]);

    await cancelPurchaseOrder(11, { id_sede: 1, sub: 7 });

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [, entry] = recordProcessTrace.mock.calls[0];
    expect(entry).toMatchObject({
      proceso: 'COMPRAS', subproceso: 'ORDEN_COMPRA_CANCELACION',
      id_sede: 1, id_usuario: 7, referencia_tipo: 'ORDEN_COMPRA', referencia_id: 11
    });
  });
});
