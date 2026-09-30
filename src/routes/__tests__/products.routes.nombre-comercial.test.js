import { describe, it, expect, vi, beforeEach } from 'vitest';

// El nombre comercial es la marca propia de la farmacia y muchos MX no
// tienen una: al enlazarlos desde HealthSphere el nombre que identifica al
// producto es el descriptivo de HS ("ABACAVIR 300 MG TABLETA RECUBIERTA").
// El esquema de la ruta lo exigía con z.string().min(2), así que guardar con
// el campo vacío se rechazaba antes de llegar al service. Debe poder
// crearse/editarse sin él, y como productos.nombre_comercial es NOT NULL en
// BD debe persistirse como cadena vacía, nunca NULL.
vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  pool: { getConnection: vi.fn() }
}));

const mockHsConnection = { query: vi.fn(), release: vi.fn() };
vi.mock('../../config/hs-db.js', () => ({
  hsPool: { getConnection: vi.fn(async () => mockHsConnection) }
}));

vi.mock('../../middleware/auth.js', () => ({
  authRequired: (req, _res, next) => { req.user = { sub: 1 }; next(); }
}));

const { query } = await import('../../config/db.js');
const { productsRouter } = await import('../products.routes.js');

function getHandlers(method, path) {
  const layer = productsRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${path} en productsRouter`);
  return layer.route.stack.map((s) => s.handle);
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

async function runRoute(method, path, req) {
  const res = makeRes();
  for (const handler of getHandlers(method, path)) {
    let err;
    await handler(req, res, (e) => { err = e; });
    if (err) return { error: err, ...res };
    if (res.body !== null) break;
  }
  return res;
}

// Índices de nombre_comercial en los params del INSERT/UPDATE de productos
// (ver createProduct/updateProduct). Se verifican contra la lista de columnas
// del SQL en un test aparte para que un reordenamiento no pase inadvertido.
const IDX_NOMBRE_INSERT = 4;
const IDX_NOMBRE_UPDATE = 2;

function routeQueries({ productoActual = null } = {}) {
  const spy = { productoInsert: null, productoUpdate: null };
  query.mockImplementation(async (sql, params = []) => {
    if (/FROM parametros_sistema/.test(sql)) return [{ valor: 'medicamento' }];
    if (/SELECT codigo_atc FROM clasificacion_atc/.test(sql)) return [];
    if (/INSERT IGNORE INTO clasificacion_atc/.test(sql)) return { affectedRows: 1 };
    if (/INSERT INTO productos/.test(sql)) { spy.productoInsert = { sql, params }; return { insertId: 77 }; }
    if (/UPDATE productos SET/.test(sql)) { spy.productoUpdate = { sql, params }; return { affectedRows: 1 }; }
    if (/SELECT id_producto, id_medicamento_hs/.test(sql)) {
      return [productoActual ?? { id_producto: 77, sku: 'MX01', nombre_comercial: '', id_medicamento_hs: 9 }];
    }
    return [];
  });
  return spy;
}

const PAYLOAD_BASE = {
  sku: 'MX01',
  id_laboratorio: 5,
  tipo_producto: 'medicamento',
  principio_activo: 'ABACAVIR'
};

describe('POST /products — nombre_comercial opcional', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
    mockHsConnection.query.mockResolvedValue([[]]);
  });

  it('crea el producto cuando no se envía nombre_comercial', async () => {
    const spy = routeQueries();

    const res = await runRoute('post', '/', { body: { ...PAYLOAD_BASE } });

    expect(res.error).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(spy.productoInsert).not.toBeNull();
  });

  it('crea el producto cuando nombre_comercial llega vacío', async () => {
    const spy = routeQueries();

    const res = await runRoute('post', '/', { body: { ...PAYLOAD_BASE, nombre_comercial: '' } });

    expect(res.error).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(spy.productoInsert).not.toBeNull();
  });

  it('persiste cadena vacía y no NULL (la columna es NOT NULL)', async () => {
    const spy = routeQueries();

    await runRoute('post', '/', { body: { ...PAYLOAD_BASE } });

    expect(spy.productoInsert.params[IDX_NOMBRE_INSERT]).toBe('');
    expect(spy.productoInsert.params[IDX_NOMBRE_INSERT]).not.toBeNull();
  });

  it('un nombre de solo espacios se guarda como cadena vacía', async () => {
    const spy = routeQueries();

    await runRoute('post', '/', { body: { ...PAYLOAD_BASE, nombre_comercial: '   ' } });

    expect(spy.productoInsert.params[IDX_NOMBRE_INSERT]).toBe('');
  });

  it('sigue guardando el nombre cuando sí se informa, recortado', async () => {
    const spy = routeQueries();

    await runRoute('post', '/', { body: { ...PAYLOAD_BASE, nombre_comercial: '  ZIAGENAVIR  ' } });

    expect(spy.productoInsert.params[IDX_NOMBRE_INSERT]).toBe('ZIAGENAVIR');
  });

  it('el índice usado para nombre_comercial corresponde a su columna en el INSERT', async () => {
    const spy = routeQueries();

    await runRoute('post', '/', { body: { ...PAYLOAD_BASE, nombre_comercial: 'ZIAGENAVIR' } });

    const { sql } = spy.productoInsert;
    const columnas = sql
      .slice(sql.indexOf('(') + 1, sql.indexOf(') VALUES'))
      .split(',')
      .map((c) => c.trim());
    expect(columnas[IDX_NOMBRE_INSERT]).toBe('nombre_comercial');
    expect((sql.match(/\?/g) || []).length).toBe(spy.productoInsert.params.length);
  });

  it('sigue exigiendo los campos que sí son obligatorios (sku, laboratorio)', async () => {
    routeQueries();

    const sinSku = await runRoute('post', '/', { body: { ...PAYLOAD_BASE, sku: undefined } });
    const sinLab = await runRoute('post', '/', { body: { ...PAYLOAD_BASE, id_laboratorio: undefined } });

    expect(sinSku.error ?? sinSku.statusCode).not.toBe(201);
    expect(sinLab.error ?? sinLab.statusCode).not.toBe(201);
  });
});

describe('PUT /products/:id — nombre_comercial opcional', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
    mockHsConnection.query.mockResolvedValue([[]]);
  });

  it('permite vaciar el nombre comercial de un producto existente', async () => {
    const spy = routeQueries({
      productoActual: { id_producto: 77, sku: 'MX01', nombre_comercial: 'ZIAGENAVIR', tipo_producto: 'medicamento', id_medicamento_hs: 9 }
    });

    const res = await runRoute('put', '/:id', { params: { id: '77' }, body: { nombre_comercial: '' } });

    expect(res.error).toBeUndefined();
    expect(spy.productoUpdate.params[IDX_NOMBRE_UPDATE]).toBe('');
  });

  it('conserva el nombre actual cuando la edición no lo toca', async () => {
    const spy = routeQueries({
      productoActual: { id_producto: 77, sku: 'MX01', nombre_comercial: 'ZIAGENAVIR', tipo_producto: 'medicamento', id_medicamento_hs: 9 }
    });

    await runRoute('put', '/:id', { params: { id: '77' }, body: { presentacion: 5 } });

    expect(spy.productoUpdate.params[IDX_NOMBRE_UPDATE]).toBe('ZIAGENAVIR');
  });

  it('el índice usado para nombre_comercial corresponde a su columna en el UPDATE', async () => {
    const spy = routeQueries({
      productoActual: { id_producto: 77, sku: 'MX01', nombre_comercial: 'ZIAGENAVIR', tipo_producto: 'medicamento', id_medicamento_hs: 9 }
    });

    await runRoute('put', '/:id', { params: { id: '77' }, body: { presentacion: 5 } });

    const { sql } = spy.productoUpdate;
    const columnas = [...sql.matchAll(/(\w+)\s*=\s*\?/g)].map((m) => m[1]);
    expect(columnas[IDX_NOMBRE_UPDATE]).toBe('nombre_comercial');
  });
});

describe('GET /products/:id — nombre del medicamento enlazado en HealthSphere', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
  });

  it('devuelve nombre_medicamento_hs para poder rotular un producto sin nombre comercial', async () => {
    routeQueries({
      productoActual: { id_producto: 77, sku: 'MX01', nombre_comercial: '', id_medicamento_hs: 9, id_forma: null, id_laboratorio: null }
    });
    mockHsConnection.query.mockResolvedValueOnce([[{ id: 9, nombre: 'ABACAVIR 300 MG TABLETA RECUBIERTA' }]]);

    const res = await runRoute('get', '/:id', { params: { id: '77' } });

    expect(res.error).toBeUndefined();
    expect(res.body.data.nombre_medicamento_hs).toBe('ABACAVIR 300 MG TABLETA RECUBIERTA');
  });
});
