import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prueba de comportamiento real (no solo regex sobre el código fuente) de
// que "fecha_factura" viaja completo por POST /ingresos: llega en el body,
// pasa la validación de zod, y queda en el mismo índice del INSERT que le
// corresponde según la lista de columnas — el tipo de bug donde columnas y
// placeholders/params se desalinean no lo detecta un review visual rápido.
const mockConnection = { query: vi.fn(), release: vi.fn() };
vi.mock('../../config/db.js', () => ({
  pool: { getConnection: vi.fn(async () => mockConnection) },
  query: vi.fn()
}));
vi.mock('../../services/traceability.service.js', () => ({
  recordProcessTrace: vi.fn(async () => {})
}));

const { ingresosRouter } = await import('../ingresos.routes.js');

function getHandlers(method, path) {
  const layer = ingresosRouter.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No se encontró ${method.toUpperCase()} ${path} en ingresosRouter`);
  return layer.route.stack.map(s => s.handle);
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
    if (err) throw err;
    if (res.body !== null) break;
  }
  return res;
}

function basePayload(overrides = {}) {
  return {
    referencia: 'ING-TEST-001',
    cantidad: 10,
    prefijo_factura: 'FV',
    numero_factura: '1234',
    fecha_factura: '2026-03-05',
    fecha_recepcion: '2026-03-06',
    estado: 'cancelado', // evita disparar actualizarInventario (fuera de alcance de esta prueba)
    items: [],
    ...overrides
  };
}

describe('POST /ingresos — fecha_factura viaja completo hasta el INSERT', () => {
  beforeEach(() => {
    mockConnection.query.mockReset();
    mockConnection.query.mockResolvedValue([{ insertId: 123 }]);
  });

  it('guarda fecha_factura en el índice de parámetro correcto del INSERT', async () => {
    const req = { body: basePayload(), user: { sub: 1 } };

    const res = await runRoute('post', '/', req);

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true });

    const [sql, params] = mockConnection.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ingresos/);

    // La columna fecha_factura debe estar en la lista de columnas del INSERT,
    // entre numero_factura y cufe (mismo orden que las columnas destructuradas).
    const columnList = sql.slice(sql.indexOf('('), sql.indexOf('VALUES')).replace(/\s+/g, '');
    const idxNumero = columnList.indexOf('numero_factura,');
    const idxFechaFactura = columnList.indexOf('fecha_factura,');
    const idxCufe = columnList.indexOf('cufe,');
    expect(idxNumero).toBeGreaterThan(-1);
    expect(idxFechaFactura).toBeGreaterThan(idxNumero);
    expect(idxCufe).toBeGreaterThan(idxFechaFactura);

    // El número de placeholders "?" debe calzar exactamente con params.length
    // (fecha_ingreso usa NOW(), no un placeholder).
    const placeholders = (sql.match(/\?/g) || []).length;
    expect(placeholders).toBe(params.length);

    // fecha_factura debe llegar como '2026-03-05' en la posición que le
    // corresponde entre numero_factura y cufe.
    const idxNumeroParam = params.indexOf('1234');
    expect(params[idxNumeroParam + 1]).toBe('2026-03-05');
  });

  it('guarda null cuando no se envía fecha_factura, sin romper el resto del insert', async () => {
    const req = { body: basePayload({ fecha_factura: undefined }), user: { sub: 1 } };

    const res = await runRoute('post', '/', req);

    expect(res.statusCode).toBe(201);
    const [, params] = mockConnection.query.mock.calls[0];
    const idxNumeroParam = params.indexOf('1234');
    expect(params[idxNumeroParam + 1]).toBeNull();
  });

  it('guarda null cuando fecha_factura llega como string vacío', async () => {
    const req = { body: basePayload({ fecha_factura: '' }), user: { sub: 1 } };

    await runRoute('post', '/', req);

    const [, params] = mockConnection.query.mock.calls[0];
    const idxNumeroParam = params.indexOf('1234');
    expect(params[idxNumeroParam + 1]).toBeNull();
  });

  it('rechaza un body inválido (sin referencia) antes de intentar el INSERT', async () => {
    const req = { body: basePayload({ referencia: undefined }), user: { sub: 1 } };

    await expect(runRoute('post', '/', req)).rejects.toMatchObject({ status: 400 });
    expect(mockConnection.query).not.toHaveBeenCalled();
  });
});

describe('GET /ingresos — fecha_factura se expone en el listado', () => {
  beforeEach(() => {
    mockConnection.query.mockReset();
    mockConnection.query.mockResolvedValue([[{ id_ingreso: 1, fecha_factura: '2026-03-05' }]]);
  });

  it('incluye i.fecha_factura en el SELECT del listado', async () => {
    const req = { query: {} };
    const res = await runRoute('get', '/', req);

    expect(res.statusCode).toBe(200);
    const [sql] = mockConnection.query.mock.calls[0];
    expect(sql).toMatch(/i\.fecha_factura/);
    expect(res.body.data[0].fecha_factura).toBe('2026-03-05');
  });
});
