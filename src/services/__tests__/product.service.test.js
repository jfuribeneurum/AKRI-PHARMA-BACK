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
const { listProducts, listAllProductsForPO, listProductsByLaboratorio, createProduct, updateProduct } = await import('../product.service.js');

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

// El desplegable "Producto" de la orden de compra mostraba solo
// nombre_comercial (la marca, ej. "NOVOEIGHT") en vez del nombre descriptivo
// de HealthSphere (ej. "FACTOR VIII HUMANO DE COAGULACION (TUROCTOCOG ALFA)
// 1500 UI...") que se ve en negrilla en Maestro MX — ambos listados para la
// OC deben traer también ese nombre enlazado.
describe('product.service listAllProductsForPO / listProductsByLaboratorio', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
  });

  it('listAllProductsForPO enriches each row with the linked HealthSphere medicamento name', async () => {
    query.mockResolvedValueOnce([
      { id_producto: 1, id_medicamento_hs: 999, nombre_comercial: 'NOVOEIGHT' }
    ]);
    mockHsConnection.query.mockResolvedValueOnce([
      [{ id: 999, nombre: 'FACTOR VIII HUMANO DE COAGULACION (TUROCTOCOG ALFA) 1500 UI POLVO PARA RECONSTITUIR A SOLUCION INYECTABLE' }]
    ]);

    const result = await listAllProductsForPO();

    expect(result[0].nombre_medicamento_hs).toBe(
      'FACTOR VIII HUMANO DE COAGULACION (TUROCTOCOG ALFA) 1500 UI POLVO PARA RECONSTITUIR A SOLUCION INYECTABLE'
    );
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/p\.id_medicamento_hs/);
  });

  it('listAllProductsForPO returns null nombre_medicamento_hs for a producto with no HS link', async () => {
    query.mockResolvedValueOnce([{ id_producto: 2, id_medicamento_hs: null, nombre_comercial: 'Ibuprofeno' }]);

    const result = await listAllProductsForPO();

    expect(result[0].nombre_medicamento_hs).toBeNull();
    expect(mockHsConnection.query).not.toHaveBeenCalled();
  });

  it('listProductsByLaboratorio enriches each row with the linked HealthSphere medicamento name', async () => {
    query.mockResolvedValueOnce([
      { id_producto: 1, id_medicamento_hs: 999, nombre_comercial: 'NOVOEIGHT' }
    ]);
    mockHsConnection.query.mockResolvedValueOnce([
      [{ id: 999, nombre: 'FACTOR VIII HUMANO DE COAGULACION (TUROCTOCOG ALFA) 1500 UI POLVO PARA RECONSTITUIR A SOLUCION INYECTABLE' }]
    ]);

    const result = await listProductsByLaboratorio(117);

    expect(result[0].nombre_medicamento_hs).toBe(
      'FACTOR VIII HUMANO DE COAGULACION (TUROCTOCOG ALFA) 1500 UI POLVO PARA RECONSTITUIR A SOLUCION INYECTABLE'
    );
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/p\.id_medicamento_hs/);
    expect(params).toEqual([117]);
  });
});

// tipo_producto se gestiona desde Parámetros (grupo 'tipo_producto'), no un
// enum fijo en código — antes era z.enum([...6 valores fijos...]) y cuando
// alguien agregaba un tipo nuevo por Parámetros (ej. "REACTIVO DIAGNOSTICO"),
// crear o editar CUALQUIER producto con ese tipo quedaba bloqueado para
// siempre con "Invalid enum value". Mismo bug ya corregido antes para
// movimientos_inventario.tipo.
describe('product.service tipo_producto dinámico (assertTipoProductoValido)', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('createProduct rechaza un tipo_producto que no existe en Parámetros, sin llegar a insertar', async () => {
    query.mockResolvedValueOnce([{ valor: 'medicamento' }, { valor: 'dispositivo' }]);

    await expect(createProduct({ tipo_producto: 'esto_no_existe', sku: 'X1', nombre_comercial: 'X' }))
      .rejects.toThrow('Tipo de producto "esto_no_existe" no es válido.');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/parametros_sistema/);
    expect(sql).toMatch(/grupo = 'tipo_producto'/);
  });

  it('createProduct acepta un tipo_producto agregado dinámicamente por Parámetros, comparando sin distinguir mayúsculas', async () => {
    // El payload no trae cum, así que checkCumDuplicate no se llega a
    // consultar: la siguiente query tras la validación de tipo es el
    // INSERT. Se hace fallar con un error centinela solo para probar que
    // el código llegó hasta ahí sin ser rechazado por assertTipoProductoValido.
    query
      .mockResolvedValueOnce([{ valor: 'REACTIVO DIAGNOSTICO' }]) // parametros_sistema
      .mockRejectedValueOnce(new Error('SENTINEL_REACHED_INSERT'));

    await expect(
      createProduct({ tipo_producto: 'reactivo diagnostico', sku: 'DM999', nombre_comercial: 'PRUEBA RAPIDA' })
    ).rejects.toThrow('SENTINEL_REACHED_INSERT');
  });

  it('updateProduct rechaza un tipo_producto inválido antes de tocar la fila', async () => {
    query
      .mockResolvedValueOnce([{ id_producto: 43, tipo_producto: 'dispositivo', cum: null }]) // ensureProductExists
      .mockResolvedValueOnce([{ valor: 'medicamento' }, { valor: 'dispositivo' }]); // parametros_sistema

    await expect(updateProduct(43, { tipo_producto: 'no_existe' })).rejects.toThrow(
      'Tipo de producto "no_existe" no es válido.'
    );

    expect(query).toHaveBeenCalledTimes(2);
  });
});
