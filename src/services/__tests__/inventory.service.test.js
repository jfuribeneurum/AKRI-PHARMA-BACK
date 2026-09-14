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
const { listStock, getInventoryLookups, getStockByProductId, registerBarcodeIngress, registerBarcodeEgress, listMovementHistory, anularMovimiento } = await import('../inventory.service.js');

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
    expect(params.at(-4)).toBe(10);
    expect(params.at(-3)).toBe(10);
  });

  it('listStock is unscoped (passes null) when no almacén is given', async () => {
    await listStock('abacavir');
    const [, params] = query.mock.calls[0];
    expect(params.at(-4)).toBeNull();
    expect(params.at(-3)).toBeNull();
  });

  it('listStock filters by tipo_producto when provided (used by Consumo de dispositivos)', async () => {
    await listStock('', 10, 'dispositivo');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/p\.tipo_producto = \?/);
    expect(params.at(-2)).toBe('dispositivo');
    expect(params.at(-1)).toBe('dispositivo');
  });

  it('listStock does not filter by tipo_producto when not given', async () => {
    await listStock('abacavir', 10);
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

  it('getInventoryLookups scopes ubicaciones by almacenIds (IN) instead of id_sede when given, for the Bodega destino city group', async () => {
    await getInventoryLookups(3, [1, 6]);
    const [ubicacionesSql, ubicacionesParams] = query.mock.calls[1];
    expect(ubicacionesSql).toMatch(/u\.id_almacen IN \(\?,\?\)/);
    expect(ubicacionesParams).toEqual([1, 6]);
  });

  it('getInventoryLookups falls back to id_sede scoping for ubicaciones when almacenIds is empty/omitted', async () => {
    await getInventoryLookups(3);
    const [ubicacionesSql, ubicacionesParams] = query.mock.calls[1];
    expect(ubicacionesSql).toMatch(/a\.id_sede = \?/);
    expect(ubicacionesParams).toEqual([3, 3]);
  });
});

describe('inventory.service listMovementHistory', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([]);
  });

  it('entrada: filters by id_almacen_destino IN (...) with id_almacen_origen IS NULL (excludes traslados)', async () => {
    await listMovementHistory({ almacenIds: [1, 6], direction: 'entrada', limit: 20 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/m\.id_almacen_destino IN \(\?,\?\)/);
    expect(sql).toMatch(/m\.id_almacen_origen IS NULL/);
    expect(params).toEqual([1, 6]);
  });

  it('salida: filters by id_almacen_origen IN (...) with id_almacen_destino IS NULL', async () => {
    await listMovementHistory({ almacenIds: [6], direction: 'salida', limit: 20 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/m\.id_almacen_origen IN \(\?\)/);
    expect(sql).toMatch(/m\.id_almacen_destino IS NULL/);
    expect(params).toEqual([6]);
  });

  it('returns an empty list without querying when almacenIds is empty', async () => {
    const result = await listMovementHistory({ almacenIds: [], direction: 'entrada' });
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('clamps limit to a safe maximum instead of trusting the caller', async () => {
    await listMovementHistory({ almacenIds: [1], direction: 'entrada', limit: 999999 });
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/LIMIT 200/);
  });
});

// anularMovimiento sigue el mismo patrón que /ingresos/:id/anular: no borra
// la fila (ledger append-only), revierte exactamente el stock que el
// movimiento original movió e inserta un ajuste que lo referencia.
describe('inventory.service anularMovimiento', () => {
  beforeEach(() => {
    withTransaction.mockClear();
    mockConnection.execute.mockReset();
    recordProcessTrace.mockReset();
  });

  it('reverses an entrada: decrements existencia at the destino and inserts a reversal shaped as a salida', async () => {
    routeExecute([
      [/SELECT \* FROM movimientos_inventario WHERE id_movimiento = \?/, () => [[{
        id_movimiento: 7217, id_producto: 44, id_lote: 798,
        id_almacen_origen: null, id_ubicacion_origen: null,
        id_almacen_destino: 1, id_ubicacion_destino: 1,
        cantidad: 1, costo_unitario: 0
      }]]],
      [/referencia_tipo = 'ANULACION_MOVIMIENTO'/, () => [[]]],
      [/FROM existencias/, () => [[{ id_existencia: 900 }]]],
      [/INSERT INTO movimientos_inventario/, () => [{ insertId: 8000 }]]
    ]);

    const result = await anularMovimiento(7217, 9, 'registro de prueba');

    expect(result).toEqual({ id_movimiento_reversion: 8000, message: 'Movimiento anulado correctamente' });

    const updateCall = mockConnection.execute.mock.calls.find(([sql]) => /^UPDATE existencias/.test(sql));
    expect(updateCall[0]).toMatch(/GREATEST\(0, cantidad_disponible - \?\)/);
    expect(updateCall[1]).toEqual([1, 900]);

    const insertCall = mockConnection.execute.mock.calls.find(([sql]) => /^INSERT INTO movimientos_inventario/.test(sql));
    // Reversión de una entrada (solo tenía destino) queda con forma de salida (solo origen).
    expect(insertCall[1]).toEqual([
      44, 798,
      1, 1, null, null,
      1, 0,
      'Anulación del movimiento #7217: registro de prueba',
      7217, 9
    ]);

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
  });

  it('reverses a salida: increments existencia at the origen (no GREATEST cap)', async () => {
    routeExecute([
      [/SELECT \* FROM movimientos_inventario WHERE id_movimiento = \?/, () => [[{
        id_movimiento: 50, id_producto: 5, id_lote: 10,
        id_almacen_origen: 6, id_ubicacion_origen: 7,
        id_almacen_destino: null, id_ubicacion_destino: null,
        cantidad: 3, costo_unitario: 50
      }]]],
      [/referencia_tipo = 'ANULACION_MOVIMIENTO'/, () => [[]]],
      [/FROM existencias/, () => [[{ id_existencia: 901 }]]],
      [/INSERT INTO movimientos_inventario/, () => [{ insertId: 8001 }]]
    ]);

    await anularMovimiento(50, 9);

    const updateCall = mockConnection.execute.mock.calls.find(([sql]) => /^UPDATE existencias/.test(sql));
    expect(updateCall[0]).toMatch(/cantidad_disponible \+ \?/);
    expect(updateCall[1]).toEqual([3, 901]);
  });

  it('rejects a traslado (both origen and destino set) — anular that from Traslados instead', async () => {
    routeExecute([
      [/SELECT \* FROM movimientos_inventario WHERE id_movimiento = \?/, () => [[{
        id_movimiento: 9, id_almacen_origen: 6, id_almacen_destino: 1
      }]]]
    ]);

    await expect(anularMovimiento(9, 9)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a movement that was already anulado', async () => {
    routeExecute([
      [/SELECT \* FROM movimientos_inventario WHERE id_movimiento = \?/, () => [[{
        id_movimiento: 7217, id_almacen_origen: null, id_almacen_destino: 1
      }]]],
      [/referencia_tipo = 'ANULACION_MOVIMIENTO'/, () => [[{ id_movimiento: 8000 }]]]
    ]);

    await expect(anularMovimiento(7217, 9)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an unknown id_movimiento with 404', async () => {
    routeExecute([
      [/SELECT \* FROM movimientos_inventario WHERE id_movimiento = \?/, () => [[]]]
    ]);

    await expect(anularMovimiento(99999, 9)).rejects.toMatchObject({ status: 404 });
  });

  it('still voids the movement (no crash) when the existencia row no longer exists', async () => {
    routeExecute([
      [/SELECT \* FROM movimientos_inventario WHERE id_movimiento = \?/, () => [[{
        id_movimiento: 1, id_producto: 1, id_lote: 1,
        id_almacen_origen: null, id_ubicacion_origen: null,
        id_almacen_destino: 1, id_ubicacion_destino: 1,
        cantidad: 1, costo_unitario: 0
      }]]],
      [/referencia_tipo = 'ANULACION_MOVIMIENTO'/, () => [[]]],
      [/FROM existencias/, () => [[]]],
      [/INSERT INTO movimientos_inventario/, () => [{ insertId: 2 }]]
    ]);

    const result = await anularMovimiento(1, 9);
    expect(result.id_movimiento_reversion).toBe(2);
    expect(mockConnection.execute.mock.calls.some(([sql]) => /^UPDATE existencias/.test(sql))).toBe(false);
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
