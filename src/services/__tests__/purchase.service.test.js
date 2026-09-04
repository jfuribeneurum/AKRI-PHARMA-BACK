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

const mockHsConnection = { query: vi.fn(), release: vi.fn() };
vi.mock('../../config/hs-db.js', () => ({
  hsPool: { getConnection: vi.fn(async () => mockHsConnection) }
}));

const { query, withTransaction } = await import('../../config/db.js');
const { recordProcessTrace } = await import('../traceability.service.js');
const {
  listWarehousesForPO, receivePurchaseOrder, getPurchaseOrder, approvePurchaseOrder, cancelPurchaseOrder,
  createPurchaseOrder, updatePurchaseOrder, listPurchases, getSedeGroupIdsForUser
} = await import('../purchase.service.js');

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

describe('purchase.service listWarehousesForPO', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([]);
  });

  it('scopes to a single given id_sede', async () => {
    await listWarehousesForPO(5);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/s\.id_sede IN \(\?\)/);
    expect(params).toEqual([5]);
  });

  it('scopes to a group of sede ids (same-city group)', async () => {
    await listWarehousesForPO([1, 3]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/s\.id_sede IN \(\?,\?\)/);
    expect(params).toEqual([1, 3]);
  });

  it('is unscoped when no id_sede is given', async () => {
    await listWarehousesForPO();
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toMatch(/s\.id_sede IN/);
    expect(params).toEqual([]);
  });

  it('short-circuits to an empty list without querying when given an empty group', async () => {
    const result = await listWarehousesForPO([]);
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

// El picker de "Bodega de destino" al crear una OC usa esto para no ofrecer
// sedes que la sesión activa no puede gestionar (ver assertGestionaOrden).
describe('purchase.service getSedeGroupIdsForUser', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('returns both Medellín sedes for a user active in Hemofilia', async () => {
    query
      .mockResolvedValueOnce([{ id_sede: 3, ciudad: 'MEDELLIN', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 1 }, { id_sede: 3 }]);

    const ids = await getSedeGroupIdsForUser({ id_sede: 3 });

    expect(ids).toEqual([1, 3]);
  });

  it('returns only Cali for a user active in Cali', async () => {
    query
      .mockResolvedValueOnce([{ id_sede: 2, ciudad: 'Cali', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 2 }]);

    const ids = await getSedeGroupIdsForUser({ id_sede: 2 });

    expect(ids).toEqual([2]);
  });

  it('rejects when the session has no valid active sede', async () => {
    query.mockResolvedValueOnce([]);

    await expect(getSedeGroupIdsForUser({ id_sede: 99 })).rejects.toMatchObject({ status: 400 });
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

// receivePurchaseOrder nunca tenía cobertura de su lógica real de recepción
// (crear/reutilizar lote, sumar/crear existencia, dejar el movimiento y
// cerrar la OC) — solo se probaban los rechazos tempranos de sede/almacén.
describe('purchase.service receivePurchaseOrder item processing', () => {
  beforeEach(() => {
    query.mockReset();
    withTransaction.mockReset();
    recordProcessTrace.mockReset();
  });

  const baseRoutes = () => ([
    ['FROM ordenes_compra WHERE id_oc', [[{ id_oc: 10, id_sede: 1, id_proveedor: 3 }]]],
    ['FROM almacenes WHERE id_almacen', [[{ id_sede: 1 }]]],
    ['INSERT INTO recepciones_compra (', [{ insertId: 200 }]],
    ['FROM ubicaciones_almacen', [[{ id_ubicacion: 1 }]]],
    ['FROM ordenes_compra_detalle WHERE id_oc', [[{ id_producto: 7, precio_venta: 500, costo_referencia: 300 }]]],
    ['FROM productos WHERE id_producto', [[{ id_producto: 7 }]]],
    ['UPDATE lotes SET precio_venta', [{ affectedRows: 1 }]],
    ['UPDATE productos SET precio_venta', [{ affectedRows: 1 }]],
    ['UPDATE existencias', [{ affectedRows: 1 }]],
    ['INSERT INTO recepciones_compra_detalle', [{ insertId: 1 }]],
    ['INSERT INTO movimientos_inventario', [{ insertId: 1 }]],
    [`SET estado = 'recibida_total'`, [{ affectedRows: 1 }]]
  ]);

  function setup(extraRoutes) {
    query.mockResolvedValueOnce([{ id_sede: 1, codigo: 'C', nombre: 'Central', es_principal: 1, activo: 1 }]);
    let connection;
    withTransaction.mockImplementation(async (cb) => {
      connection = mockConnection([...extraRoutes, ...baseRoutes()]);
      return cb(connection);
    });
    return () => connection;
  }

  const item = { id_producto: 7, numero_lote: 'L-1', fecha_vencimiento: '2027-01-01', cantidad_recibida: 20, costo_unitario: 100 };

  it('reuses an existing lote (same producto + numero_lote) and refreshes its precio_venta from the OC, instead of inserting a duplicate', async () => {
    const getConnection = setup([
      ['FROM lotes WHERE id_producto', [[{ id_lote: 55 }]]],
      ['FROM existencias WHERE id_lote', [[]]],
      ['INSERT INTO existencias (', [{ insertId: 1 }]]
    ]);

    await receivePurchaseOrder(10, { id_almacen: 1, items: [item] }, { id_sede: 1, sub: 9 });

    const calls = getConnection().execute.mock.calls;
    expect(calls.some(([sql]) => sql.includes('INSERT INTO lotes'))).toBe(false);
    const updateLote = calls.find(([sql]) => sql.includes('UPDATE lotes SET precio_venta'));
    expect(updateLote[1]).toEqual([500, 55]);
  });

  it('creates a new lote when no existing lote matches producto + numero_lote', async () => {
    const getConnection = setup([
      ['FROM lotes WHERE id_producto', [[]]],
      ['INSERT INTO lotes (', [{ insertId: 77 }]],
      ['FROM existencias WHERE id_lote', [[]]],
      ['INSERT INTO existencias (', [{ insertId: 1 }]]
    ]);

    await receivePurchaseOrder(10, { id_almacen: 1, items: [item] }, { id_sede: 1, sub: 9 });

    const calls = getConnection().execute.mock.calls;
    const insertLote = calls.find(([sql]) => sql.includes('INSERT INTO lotes ('));
    expect(insertLote[1]).toEqual([7, 3, 'L-1', '2027-01-01', 100, 500]);
    const insertMov = calls.find(([sql]) => sql.includes('INSERT INTO movimientos_inventario'));
    expect(insertMov[1]).toEqual(expect.arrayContaining([7, 77, 1, 1, 20, 100]));
  });

  it('adds to an existing existencia (same lote + ubicación) instead of inserting a second row', async () => {
    const getConnection = setup([
      ['FROM lotes WHERE id_producto', [[{ id_lote: 55 }]]],
      ['FROM existencias WHERE id_lote', [[{ id_existencia: 900, cantidad_disponible: 10 }]]]
    ]);

    await receivePurchaseOrder(10, { id_almacen: 1, items: [item] }, { id_sede: 1, sub: 9 });

    const calls = getConnection().execute.mock.calls;
    expect(calls.some(([sql]) => sql.includes('INSERT INTO existencias ('))).toBe(false);
    const updateExistencia = calls.find(([sql]) => sql.includes('UPDATE existencias'));
    expect(updateExistencia[1]).toEqual([20, 900]);
  });

  it('creates a new existencia row when the lote has no stock yet at that ubicación', async () => {
    const getConnection = setup([
      ['FROM lotes WHERE id_producto', [[{ id_lote: 55 }]]],
      ['FROM existencias WHERE id_lote', [[]]],
      ['INSERT INTO existencias (', [{ insertId: 1 }]]
    ]);

    await receivePurchaseOrder(10, { id_almacen: 1, items: [item] }, { id_sede: 1, sub: 9 });

    const calls = getConnection().execute.mock.calls;
    const insertExistencia = calls.find(([sql]) => sql.includes('INSERT INTO existencias ('));
    expect(insertExistencia[1]).toEqual([55, 1, 1, 20]);
  });

  it('closes the order as recibida_total and leaves an audit trace after processing all items', async () => {
    const getConnection = setup([
      ['FROM lotes WHERE id_producto', [[{ id_lote: 55 }]]],
      ['FROM existencias WHERE id_lote', [[{ id_existencia: 900, cantidad_disponible: 10 }]]]
    ]);

    await receivePurchaseOrder(10, { id_almacen: 1, items: [item] }, { id_sede: 1, sub: 9 });

    const calls = getConnection().execute.mock.calls;
    expect(calls.some(([sql]) => sql.includes(`SET estado = 'recibida_total'`))).toBe(true);
    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [, entry] = recordProcessTrace.mock.calls[0];
    expect(entry).toMatchObject({ proceso: 'COMPRAS', subproceso: 'RECEPCION_ORDEN_COMPRA', referencia_id: 10 });
  });

  it('rejects when the target almacén has no ubicaciones configured', async () => {
    setup([
      ['FROM ubicaciones_almacen', [[]]]
    ]);

    await expect(
      receivePurchaseOrder(10, { id_almacen: 1, items: [item] }, { id_sede: 1, sub: 9 })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects when a receipt item references a producto that does not exist', async () => {
    setup([
      ['FROM productos WHERE id_producto', [[]]]
    ]);

    await expect(
      receivePurchaseOrder(10, { id_almacen: 1, items: [item] }, { id_sede: 1, sub: 9 })
    ).rejects.toMatchObject({ status: 404 });
  });
});

// El documento/PDF de la orden de compra necesita el teléfono de la sede y
// el nombre de quien la creó/aprobó — getPurchaseOrder debe traerlos
// resueltos (no solo los ids crudos de la tabla).
describe('purchase.service getPurchaseOrder', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
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

  // El PDF de la orden (buildOrdenCompraHtml en el frontend) muestra el
  // "Nombre" de cada item con el mismo criterio que el selector de MX al
  // armar la orden: prioriza el nombre enlazado de HealthSphere sobre el
  // nombre_comercial local. Si getPurchaseOrder no trae ese nombre, el PDF
  // termina mostrando el nombre_comercial crudo — que puede repetirse
  // idéntico para varios productos distintos (varias marcas cargadas bajo
  // el mismo nombre comercial genérico) y hace imposible distinguirlos.
  it('enriches each item with the linked HealthSphere medicamento name', async () => {
    query
      .mockResolvedValueOnce([{ id_oc: 7, numero_oc: 'OC-0000007' }])
      .mockResolvedValueOnce([
        { id_oc_detalle: 1, id_producto: 451, id_medicamento_hs: 1562, nombre_comercial: 'ESPEROCT' }
      ]);
    mockHsConnection.query.mockResolvedValueOnce([
      [{ id: 1562, nombre: 'METFORMINA 850 MG TABLETA RECUBIERTA' }]
    ]);

    const oc = await getPurchaseOrder(7);

    expect(oc.items[0].nombre_medicamento_hs).toBe('METFORMINA 850 MG TABLETA RECUBIERTA');
  });

  it('leaves nombre_medicamento_hs null for an item whose producto has no HealthSphere link', async () => {
    query
      .mockResolvedValueOnce([{ id_oc: 7, numero_oc: 'OC-0000007' }])
      .mockResolvedValueOnce([
        { id_oc_detalle: 1, id_producto: 900, id_medicamento_hs: null, nombre_comercial: 'ALCOHOL ANTISEPTICO' }
      ]);

    const oc = await getPurchaseOrder(7);

    expect(oc.items[0].nombre_medicamento_hs).toBeNull();
    expect(mockHsConnection.query).not.toHaveBeenCalled();
  });
});

// approvePurchaseOrder marcaba estado='aprobada' pero nunca llenaba
// aprobado_por/fecha_aprobacion pese a que la tabla los tiene — sin esto
// el documento de la orden nunca puede mostrar quién la aprobó.
//
// La regla de "solo la sede central gestiona compras" se reemplazó por
// grupos de sede por ciudad (assertGestionaOrden): la orden se fetch primero
// (query #1), luego se resuelve la sede activa del usuario (query #2) y el
// grupo de ciudad de esa sede (query #3), antes de tocar el estado.
describe('purchase.service approvePurchaseOrder', () => {
  beforeEach(() => {
    query.mockReset();
    recordProcessTrace.mockReset();
  });

  it('records who approved the order', async () => {
    query
      .mockResolvedValueOnce([{ id_oc: 10, numero_oc: 'OC-0000010', estado: 'enviada', id_sede: 1 }])
      .mockResolvedValueOnce([{ id_sede: 1, ciudad: 'MEDELLIN', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 1 }, { id_sede: 3 }])
      .mockResolvedValueOnce([]);

    await approvePurchaseOrder(10, { id_sede: 1, sub: 42 });

    const updateCall = query.mock.calls.find(([sql]) => /UPDATE ordenes_compra SET estado = 'aprobada'/.test(sql));
    expect(updateCall[0]).toMatch(/aprobado_por = \?, fecha_aprobacion = NOW\(\)/);
    expect(updateCall[1]).toEqual([42, 10]);
  });

  it('leaves an audit trace of the approval', async () => {
    query
      .mockResolvedValueOnce([{ id_oc: 10, numero_oc: 'OC-0000010', estado: 'enviada', id_sede: 1 }])
      .mockResolvedValueOnce([{ id_sede: 1, ciudad: 'MEDELLIN', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 1 }, { id_sede: 3 }])
      .mockResolvedValueOnce([]);

    await approvePurchaseOrder(10, { id_sede: 1, sub: 42 });

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [, entry] = recordProcessTrace.mock.calls[0];
    expect(entry).toMatchObject({
      proceso: 'COMPRAS', subproceso: 'ORDEN_COMPRA_APROBACION',
      id_sede: 1, id_usuario: 42, referencia_tipo: 'ORDEN_COMPRA', referencia_id: 10
    });
  });

  it('rejects with 404 when the order does not exist', async () => {
    query.mockResolvedValueOnce([]);

    await expect(approvePurchaseOrder(999, { id_sede: 1, sub: 42 })).rejects.toMatchObject({ status: 404 });
  });

  it('rejects an order that is already aprobada/cancelada/recibida_total', async () => {
    for (const estado of ['aprobada', 'cancelada', 'recibida_total']) {
      query.mockReset();
      query
        .mockResolvedValueOnce([{ id_oc: 10, numero_oc: 'OC-0000010', estado, id_sede: 1 }])
        .mockResolvedValueOnce([{ id_sede: 1, ciudad: 'MEDELLIN', activo: 1 }])
        .mockResolvedValueOnce([{ id_sede: 1 }]);

      await expect(approvePurchaseOrder(10, { id_sede: 1, sub: 42 })).rejects.toMatchObject({ status: 400 });
    }
  });

  // El caso "sede central" ya no existe: ahora cada grupo de ciudad gestiona
  // sus propias órdenes — un usuario activo en Cali no puede aprobar una
  // orden que pertenece a una sede de Medellín.
  it('rejects when the approving user is on a different sede group (city) than the order', async () => {
    query
      .mockResolvedValueOnce([{ id_oc: 10, numero_oc: 'OC-0000010', estado: 'enviada', id_sede: 1 }])
      .mockResolvedValueOnce([{ id_sede: 2, ciudad: 'Cali', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 2 }]);

    await expect(approvePurchaseOrder(10, { id_sede: 2, sub: 42 })).rejects.toMatchObject({ status: 403 });
  });

  // El caso que motivó el cambio: alguien activo en Hemofilia (sede 3) debe
  // poder aprobar una orden que pertenece a Diabetes (sede 1) — ambas son
  // sedes de Medellín.
  it('allows a user active in Hemofilia to approve an order that belongs to Diabetes — same city group', async () => {
    query
      .mockResolvedValueOnce([{ id_oc: 10, numero_oc: 'OC-0000010', estado: 'enviada', id_sede: 1 }])
      .mockResolvedValueOnce([{ id_sede: 3, ciudad: 'MEDELLIN', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 1 }, { id_sede: 3 }])
      .mockResolvedValueOnce([]);

    await expect(approvePurchaseOrder(10, { id_sede: 3, sub: 42 })).resolves.toMatchObject({ estado: 'aprobada' });
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
      .mockResolvedValueOnce([{ id_oc: 11, numero_oc: 'OC-0000011', estado: 'enviada', id_sede: 1 }])
      .mockResolvedValueOnce([{ id_sede: 1, ciudad: 'MEDELLIN', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 1 }, { id_sede: 3 }])
      .mockResolvedValueOnce([]);

    await cancelPurchaseOrder(11, { id_sede: 1, sub: 7 });

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [, entry] = recordProcessTrace.mock.calls[0];
    expect(entry).toMatchObject({
      proceso: 'COMPRAS', subproceso: 'ORDEN_COMPRA_CANCELACION',
      id_sede: 1, id_usuario: 7, referencia_tipo: 'ORDEN_COMPRA', referencia_id: 11
    });
  });

  it('rejects with 404 when the order does not exist', async () => {
    query.mockResolvedValueOnce([]);

    await expect(cancelPurchaseOrder(999, { id_sede: 1, sub: 7 })).rejects.toMatchObject({ status: 404 });
  });

  it('rejects an order that is already aprobada/cancelada/recibida_total', async () => {
    for (const estado of ['aprobada', 'cancelada', 'recibida_total']) {
      query.mockReset();
      query
        .mockResolvedValueOnce([{ id_oc: 11, numero_oc: 'OC-0000011', estado, id_sede: 1 }])
        .mockResolvedValueOnce([{ id_sede: 1, ciudad: 'MEDELLIN', activo: 1 }])
        .mockResolvedValueOnce([{ id_sede: 1 }]);

      await expect(cancelPurchaseOrder(11, { id_sede: 1, sub: 7 })).rejects.toMatchObject({ status: 400 });
    }
  });

  it('rejects when the cancelling user is on a different sede group (city) than the order', async () => {
    query
      .mockResolvedValueOnce([{ id_oc: 11, numero_oc: 'OC-0000011', estado: 'enviada', id_sede: 1 }])
      .mockResolvedValueOnce([{ id_sede: 4, ciudad: 'Pereira', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 4 }]);

    await expect(cancelPurchaseOrder(11, { id_sede: 4, sub: 7 })).rejects.toMatchObject({ status: 403 });
  });
});

// createPurchaseOrder no tenía ninguna prueba: ni la numeración consecutiva,
// ni el cálculo de totales, ni — crítico — que la respuesta devuelva el
// numero_oc real y no el que venga (vacío) en el payload del formulario, que
// lo deja readonly hasta que el backend responde.
//
// Ya no existe una única "sede central" que gestione todas las compras:
// cualquier sede activa válida puede crear su propia orden (assertGestiona-
// Orden/assertSedeActivaValida) — la orden queda con el id_sede de quien la
// crea, no fijo a una sede.
describe('purchase.service createPurchaseOrder', () => {
  beforeEach(() => {
    query.mockReset();
    withTransaction.mockReset();
    recordProcessTrace.mockReset();
  });

  it('creates the order under the creating user\'s own active sede — not restricted to a single central sede', async () => {
    query.mockResolvedValueOnce([{ id_sede: 2, codigo: '03', nombre: 'SEDE CALI', ciudad: 'Cali', es_principal: 0, activo: 1 }]);

    let connection;
    withTransaction.mockImplementation(async (cb) => {
      connection = mockConnection([
        ['SELECT numero_oc FROM ordenes_compra', [[]]],
        ['INSERT INTO ordenes_compra (', [{ insertId: 60 }]],
        ['INSERT INTO ordenes_compra_detalle', [{ insertId: 1 }]]
      ]);
      return cb(connection);
    });

    const result = await createPurchaseOrder(
      { id_proveedor: 1, items: [{ id_producto: 1, cantidad: 1, precio_unitario: 100 }] },
      { id_sede: 2, sub: 1 }
    );

    expect(result).toMatchObject({ id_sede: 2, sede: 'SEDE CALI' });
    const headerCall = connection.execute.mock.calls.find(([sql]) => sql.includes('INSERT INTO ordenes_compra ('));
    expect(headerCall[1][0]).toBe(2);
  });

  it('rejects when the user has no valid active sede at all', async () => {
    query.mockResolvedValueOnce([]);

    await expect(
      createPurchaseOrder({ id_proveedor: 1, items: [] }, { id_sede: 99, sub: 1 })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('numbers the first order OC-0000001 when there is no prior order, calculates totals correctly, persists one detail row per item, and returns the real generated numero_oc — not whatever came in payload.numero_oc', async () => {
    query.mockResolvedValueOnce([{ id_sede: 1, codigo: 'C', nombre: 'Central', es_principal: 1, activo: 1 }]);

    let connection;
    withTransaction.mockImplementation(async (cb) => {
      connection = mockConnection([
        ['SELECT numero_oc FROM ordenes_compra', [[]]],
        ['INSERT INTO ordenes_compra (', [{ insertId: 55 }]],
        ['INSERT INTO ordenes_compra_detalle', [{ insertId: 1 }]]
      ]);
      return cb(connection);
    });

    const payload = {
      numero_oc: '', // el campo del formulario llega vacío — el backend nunca debe usarlo
      id_proveedor: 9,
      items: [
        { id_producto: 1, cantidad: 10, precio_unitario: 100, descuento: 50, impuesto: 19 },
        { id_producto: 2, cantidad: 2, precio_unitario: 500 }
      ]
    };

    const result = await createPurchaseOrder(payload, { id_sede: 1, sub: 3 });

    // subtotal = (10*100 - 50) + (2*500 - 0) = 950 + 1000 = 1950; impuestos = 19; total = 1969
    expect(result).toMatchObject({
      id_oc: 55, numero_oc: 'OC-0000001', id_sede: 1, sede: 'Central',
      subtotal: 1950, impuestos: 19, total: 1969
    });

    const detailCalls = connection.execute.mock.calls.filter(([sql]) => sql.includes('INSERT INTO ordenes_compra_detalle'));
    expect(detailCalls).toHaveLength(2);
    expect(detailCalls[0][1]).toEqual([55, 1, 10, 100, 0, 0, 50, 19, null]);
    expect(detailCalls[1][1]).toEqual([55, 2, 2, 500, 0, 0, 0, 0, null]);

    const headerCall = connection.execute.mock.calls.find(([sql]) => sql.includes('INSERT INTO ordenes_compra ('));
    expect(headerCall[1]).toEqual([1, 'OC-0000001', 9, 'enviada', 1950, 19, 1969, null, 3]);

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
  });

  it('continues the consecutivo sequence from the last existing numero_oc', async () => {
    query.mockResolvedValueOnce([{ id_sede: 1, codigo: 'C', nombre: 'Central', es_principal: 1, activo: 1 }]);

    withTransaction.mockImplementation(async (cb) => {
      const connection = mockConnection([
        ['SELECT numero_oc FROM ordenes_compra', [[{ numero_oc: 'OC-0000041' }]]],
        ['INSERT INTO ordenes_compra (', [{ insertId: 56 }]],
        ['INSERT INTO ordenes_compra_detalle', [{ insertId: 1 }]]
      ]);
      return cb(connection);
    });

    const result = await createPurchaseOrder(
      { id_proveedor: 9, items: [{ id_producto: 1, cantidad: 1, precio_unitario: 10 }] },
      { id_sede: 1, sub: 3 }
    );

    expect(result.numero_oc).toBe('OC-0000042');
  });
});

// updatePurchaseOrder tampoco tenía pruebas: el guard de estado editable, el
// reemplazo completo de items y el recálculo de totales.
//
// El guard de sede (assertGestionaOrden) corre DENTRO de la transacción,
// después de leer la orden vía connection.execute — así que query() (no
// connection.execute) recibe la sede activa del usuario y luego el grupo de
// ciudad de esa sede, en ese orden.
describe('purchase.service updatePurchaseOrder', () => {
  beforeEach(() => {
    query.mockReset();
    withTransaction.mockReset();
    recordProcessTrace.mockReset();
  });

  it('rejects with 404 when the order does not exist', async () => {
    withTransaction.mockImplementation(async (cb) => {
      const connection = mockConnection([
        ['FROM ordenes_compra WHERE id_oc', [[]]]
      ]);
      return cb(connection);
    });

    await expect(
      updatePurchaseOrder(999, { id_proveedor: 1, items: [] }, { id_sede: 1, sub: 1 })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects when the editing user is on a different sede group (city) than the order', async () => {
    query
      .mockResolvedValueOnce([{ id_sede: 2, ciudad: 'Cali', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 2 }]);
    withTransaction.mockImplementation(async (cb) => {
      const connection = mockConnection([
        ['FROM ordenes_compra WHERE id_oc', [[{ id_oc: 10, id_sede: 1, numero_oc: 'OC-0000010', estado: 'enviada' }]]]
      ]);
      return cb(connection);
    });

    await expect(
      updatePurchaseOrder(10, { id_proveedor: 1, items: [] }, { id_sede: 2, sub: 1 })
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects editing an order that is already aprobada/cancelada/recibida_total', async () => {
    for (const estado of ['aprobada', 'cancelada', 'recibida_total']) {
      query.mockReset();
      query
        .mockResolvedValueOnce([{ id_sede: 1, ciudad: 'MEDELLIN', activo: 1 }])
        .mockResolvedValueOnce([{ id_sede: 1 }]);
      withTransaction.mockImplementation(async (cb) => {
        const connection = mockConnection([
          ['FROM ordenes_compra WHERE id_oc', [[{ id_oc: 10, id_sede: 1, numero_oc: 'OC-0000010', estado }]]]
        ]);
        return cb(connection);
      });

      await expect(
        updatePurchaseOrder(10, { id_proveedor: 1, items: [] }, { id_sede: 1, sub: 1 })
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it('replaces every item (delete + re-insert), recalculates totals, sets estado editada, and traces it', async () => {
    query
      .mockResolvedValueOnce([{ id_sede: 1, ciudad: 'MEDELLIN', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 1 }]);

    let connection;
    withTransaction.mockImplementation(async (cb) => {
      connection = mockConnection([
        ['FROM ordenes_compra WHERE id_oc', [[{ id_oc: 10, id_sede: 1, numero_oc: 'OC-0000010', estado: 'enviada' }]]],
        ['UPDATE ordenes_compra', [{ affectedRows: 1 }]],
        ['DELETE FROM ordenes_compra_detalle', [{ affectedRows: 3 }]],
        ['INSERT INTO ordenes_compra_detalle', [{ insertId: 1 }]]
      ]);
      return cb(connection);
    });

    const result = await updatePurchaseOrder(
      10,
      { id_proveedor: 4, items: [{ id_producto: 1, cantidad: 5, precio_unitario: 200 }], observaciones: 'urgente' },
      { id_sede: 1, sub: 3 }
    );

    expect(result).toMatchObject({ id_oc: 10, numero_oc: 'OC-0000010', estado: 'editada', subtotal: 1000, impuestos: 0, total: 1000 });

    const calls = connection.execute.mock.calls;
    const deleteIndex = calls.findIndex(([sql]) => sql.includes('DELETE FROM ordenes_compra_detalle'));
    const insertIndex = calls.findIndex(([sql]) => sql.includes('INSERT INTO ordenes_compra_detalle'));
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(deleteIndex);

    const updateHeader = calls.find(([sql]) => sql.includes('UPDATE ordenes_compra'));
    expect(updateHeader[1]).toEqual([4, 1000, 0, 1000, 'urgente', 10]);

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
  });
});

// listPurchases ya no distingue una única sede central que ve todo: cada
// usuario ve las órdenes de su grupo de sede (mismas ciudad) — Cali solo ve
// las suyas, pero alguien activo en cualquiera de las dos sedes de Medellín
// ve las órdenes de ambas.
describe('purchase.service listPurchases', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('scopes to the sedes of the same city as a single-sede city (Cali)', async () => {
    query
      .mockResolvedValueOnce([{ id_sede: 2, ciudad: 'Cali', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 2 }])
      .mockResolvedValueOnce([]);

    await listPurchases({ id_sede: 2 });

    const [sql, params] = query.mock.calls[2];
    expect(sql).toMatch(/WHERE oc\.id_sede IN \(\?\)/);
    expect(params).toEqual([2]);
  });

  it('includes both Medellín sedes (Diabetes and Hemofilia) for a user active in either one', async () => {
    query
      .mockResolvedValueOnce([{ id_sede: 3, ciudad: 'MEDELLIN', activo: 1 }])
      .mockResolvedValueOnce([{ id_sede: 1 }, { id_sede: 3 }])
      .mockResolvedValueOnce([]);

    await listPurchases({ id_sede: 3 });

    const [sql, params] = query.mock.calls[2];
    expect(sql).toMatch(/WHERE oc\.id_sede IN \(\?,\?\)/);
    expect(params).toEqual([1, 3]);
  });

  it('does not scope the listing when called without a user', async () => {
    query.mockResolvedValueOnce([]);

    await listPurchases();

    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toMatch(/WHERE oc\.id_sede = \?/);
    expect(params).toEqual([]);
  });
});
