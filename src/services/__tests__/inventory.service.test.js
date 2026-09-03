import { describe, it, expect, vi, beforeEach } from 'vitest';

// listStock/getInventoryLookups used to return every warehouse's stock
// unscoped, regardless of who was asking — the active-almacén selector
// feature depends on these actually filtering by the caller's session.
const { mockConnection } = vi.hoisted(() => ({ mockConnection: { execute: vi.fn() } }));

vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (work) => work(mockConnection))
}));
vi.mock('../../config/env.js', () => ({ env: { PUBLIC_UPLOAD_BASE_URL: 'https://cdn.test', ALLOW_STOCK_NEGATIVE: false } }));
vi.mock('../traceability.service.js', () => ({
  recordProcessTrace: vi.fn()
}));

const { query, withTransaction } = await import('../../config/db.js');
const { recordProcessTrace } = await import('../traceability.service.js');
const { listStock, getInventoryLookups, getStockByProductId, registerBarcodeIngress, registerBarcodeEgress } = await import('../inventory.service.js');

// Router genérico para connection.execute, mismo patrón que dispensacion-hs
// y sale.service.test.js: {patrón: () => filas}, el resto de INSERT/UPDATE
// que no importan al test devuelven [] / {insertId}.
function routeExecute(overrides) {
  mockConnection.execute.mockImplementation(async (sql) => {
    for (const [pattern, handler] of overrides) {
      if (pattern.test(sql)) return handler(sql);
    }
    if (/^INSERT/.test(sql)) return [{ insertId: 1 }];
    if (/^UPDATE/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}

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

  it('getStockByProductId filters by the almacén\'s sede when idSede is given, so a formulación never offers another sede\'s lots for dispensing', async () => {
    await getStockByProductId(7, 3);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/a\.id_sede = \?/);
    expect(params).toEqual([7, 3, 3]);
  });

  it('getStockByProductId is unscoped (passes null) when no idSede is given', async () => {
    await getStockByProductId(7);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([7, null, null]);
  });

  // El catálogo tiene decenas de genéricos cargados como más de un producto
  // local (duplicados). Si getStockByProductId solo aceptara un id, el
  // stock de los demás candidatos quedaría invisible aunque exista.
  it('getStockByProductId accepts an array of ids and sums stock across every duplicate producto', async () => {
    await getStockByProductId([89, 90, 91], 1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/l\.id_producto IN \(\?,\?,\?\)/);
    expect(params).toEqual([89, 90, 91, 1, 1]);
  });

  it('getStockByProductId returns an empty result without querying when given an empty array', async () => {
    const result = await getStockByProductId([], 1);
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

// registerBarcodeIngress/Egress movían inventario real (existencias +
// movimientos_inventario) por escaneo pero nunca dejaban trazabilidad en
// procesos_terminados_trazabilidad, a diferencia de createMovement (el
// registro manual) en este mismo archivo.
describe('inventory.service barcode scan traceability', () => {
  beforeEach(() => {
    withTransaction.mockClear();
    mockConnection.execute.mockReset();
    recordProcessTrace.mockReset();
  });

  it('registerBarcodeIngress records an audit trace of the scanned entrada', async () => {
    routeExecute([
      [/FROM productos p/, () => [[{ id_producto: 7, nombre_comercial: 'Acetaminofén', costo_referencia: 100, precio_venta: 200 }]]],
      [/FROM ubicaciones_almacen u/, () => [[{ id_ubicacion: 1, id_almacen: 1, ubicacion: 'Estante A', almacen: 'Principal' }]]],
      [/SELECT id_lote, numero_lote/, () => [[]]],
      [/INSERT INTO lotes/, () => [{ insertId: 3 }]],
      [/FROM existencias WHERE id_lote = \? AND id_ubicacion = \?/, () => [[]]],
      [/INSERT INTO movimientos_inventario/, () => [{ insertId: 55 }]],
      [/INSERT INTO escaneos_codigo_barras/, () => [{ insertId: 90 }]]
    ]);

    await registerBarcodeIngress(
      { barcode: '7501234567890', numero_lote: 'L-1', fecha_vencimiento: '2027-01-01', id_ubicacion_destino: 1, quantity: 10 },
      9
    );

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [connectionArg, entry] = recordProcessTrace.mock.calls[0];
    expect(connectionArg).toBe(mockConnection);
    expect(entry).toMatchObject({
      proceso: 'INVENTARIO', subproceso: 'INGRESO_ESCANEO',
      id_usuario: 9, referencia_tipo: 'MOVIMIENTO_INVENTARIO', referencia_id: 55
    });
  });

  it('registerBarcodeEgress records an audit trace of the scanned salida', async () => {
    routeExecute([
      [/FROM productos p/, () => [[{ id_producto: 7, nombre_comercial: 'Acetaminofén', costo_referencia: 100 }]]],
      [/FROM existencias e/, () => [[{
        id_existencia: 500, id_almacen: 1, id_ubicacion: 1, cantidad_disponible: 10,
        id_lote: 3, numero_lote: 'L-1', fecha_vencimiento: '2027-01-01', costo_unitario: 100,
        almacen: 'Principal', ubicacion: 'Estante A'
      }]]],
      [/INSERT INTO movimientos_inventario/, () => [{ insertId: 66 }]],
      [/INSERT INTO escaneos_codigo_barras/, () => [{ insertId: 91 }]]
    ]);

    await registerBarcodeEgress({ barcode: '7501234567890', quantity: 2 }, 9);

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [connectionArg, entry] = recordProcessTrace.mock.calls[0];
    expect(connectionArg).toBe(mockConnection);
    expect(entry).toMatchObject({
      proceso: 'INVENTARIO', subproceso: 'EGRESO_ESCANEO',
      id_usuario: 9, referencia_tipo: 'MOVIMIENTO_INVENTARIO', referencia_id: 66
    });
  });
});
