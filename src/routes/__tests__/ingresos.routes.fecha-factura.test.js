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

// Responde según la consulta: GET_LOCK concedido, ninguna factura previa
// (salvo que se pase una), y el INSERT con su insertId.
function fakeQuery({ facturaExistente = null, lockOk = 1 } = {}) {
  return async (sql) => {
    if (/GET_LOCK/.test(sql)) return [[{ ok: lockOk }]];
    if (/RELEASE_LOCK/.test(sql)) return [[{}]];
    if (/FROM ingresos\s+WHERE UPPER/.test(sql)) return [facturaExistente ? [facturaExistente] : []];
    return [{ insertId: 123 }];
  };
}

function insertCall() {
  const call = mockConnection.query.mock.calls.find(([sql]) => /INSERT INTO ingresos\s*\(/.test(sql));
  if (!call) throw new Error('No se ejecutó el INSERT INTO ingresos');
  return call;
}

describe('POST /ingresos — fecha_factura viaja completo hasta el INSERT', () => {
  beforeEach(() => {
    mockConnection.query.mockReset();
    mockConnection.query.mockImplementation(fakeQuery());
  });

  it('guarda fecha_factura en el índice de parámetro correcto del INSERT', async () => {
    const req = { body: basePayload(), user: { sub: 1 } };

    const res = await runRoute('post', '/', req);

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true });

    const [sql, params] = insertCall();
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
    const [, params] = insertCall();
    const idxNumeroParam = params.indexOf('1234');
    expect(params[idxNumeroParam + 1]).toBeNull();
  });

  it('guarda null cuando fecha_factura llega como string vacío', async () => {
    const req = { body: basePayload({ fecha_factura: '' }), user: { sub: 1 } };

    await runRoute('post', '/', req);

    const [, params] = insertCall();
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

describe('POST /ingresos — prefijo + número de factura es único', () => {
  beforeEach(() => {
    mockConnection.query.mockReset();
  });

  it('rechaza con 409 una factura que ya está en otro ingreso, sin insertar nada', async () => {
    mockConnection.query.mockImplementation(fakeQuery({ facturaExistente: { id_ingreso: 9, referencia: 'ING-0009' } }));
    const req = { body: basePayload(), user: { sub: 1 } };

    const res = await runRoute('post', '/', req);

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe('La factura FV1234 ya fue registrada en el ingreso ING-0009.');
    expect(mockConnection.query.mock.calls.some(([sql]) => /INSERT INTO ingresos/.test(sql))).toBe(false);
  });

  it('compara prefijo y número normalizados (mayúsculas, sin espacios) y excluye anulados', async () => {
    mockConnection.query.mockImplementation(fakeQuery());
    const req = { body: basePayload({ prefijo_factura: ' fv ', numero_factura: ' 1234 ' }), user: { sub: 1 } };

    const res = await runRoute('post', '/', req);

    expect(res.statusCode).toBe(201);
    const [sql, params] = mockConnection.query.mock.calls.find(([s]) => /WHERE UPPER/.test(s));
    expect(params).toEqual(['FV', '1234']);
    expect(sql).toMatch(/estado <> 'anulado'/);
  });

  it('toma un lock por factura y lo libera después de guardar', async () => {
    mockConnection.query.mockImplementation(fakeQuery());
    await runRoute('post', '/', { body: basePayload(), user: { sub: 1 } });

    const sqls = mockConnection.query.mock.calls.map(([s]) => s);
    const iLock = sqls.findIndex(s => /GET_LOCK/.test(s));
    const iInsert = sqls.findIndex(s => /INSERT INTO ingresos\s*\(/.test(s));
    const iRelease = sqls.findIndex(s => /RELEASE_LOCK/.test(s));
    expect(iLock).toBeGreaterThan(-1);
    expect(iLock).toBeLessThan(iInsert);
    expect(iRelease).toBeGreaterThan(iInsert);
    expect(mockConnection.query.mock.calls[iLock][1]).toEqual(['ingreso_factura:FV:1234']);
  });

  it('responde 409 si otra persona está guardando la misma factura en ese momento', async () => {
    mockConnection.query.mockImplementation(fakeQuery({ lockOk: 0 }));
    const res = await runRoute('post', '/', { body: basePayload(), user: { sub: 1 } });

    expect(res.statusCode).toBe(409);
    expect(mockConnection.query.mock.calls.some(([sql]) => /INSERT INTO ingresos/.test(sql))).toBe(false);
    expect(mockConnection.query.mock.calls.some(([sql]) => /RELEASE_LOCK/.test(sql))).toBe(false);
  });

  it('no valida unicidad cuando el ingreso no trae factura (devoluciones)', async () => {
    mockConnection.query.mockImplementation(fakeQuery());
    const req = { body: basePayload({ prefijo_factura: null, numero_factura: null, es_devolucion: true }), user: { sub: 1 } };

    const res = await runRoute('post', '/', req);

    expect(res.statusCode).toBe(201);
    expect(mockConnection.query.mock.calls.some(([sql]) => /GET_LOCK|WHERE UPPER/.test(sql))).toBe(false);
  });
});

describe('GET /ingresos/factura-disponible', () => {
  beforeEach(() => {
    mockConnection.query.mockReset();
  });

  it('indica que la factura no está disponible y en qué ingreso está', async () => {
    mockConnection.query.mockImplementation(fakeQuery({ facturaExistente: { id_ingreso: 9, referencia: 'ING-0009' } }));
    const res = await runRoute('get', '/factura-disponible', { query: { prefijo: 'fv', numero: '1234' } });

    expect(res.body.data).toEqual({
      disponible: false,
      referencia: 'ING-0009',
      message: 'La factura FV1234 ya fue registrada en el ingreso ING-0009.'
    });
  });

  it('indica disponible cuando no existe', async () => {
    mockConnection.query.mockImplementation(fakeQuery());
    const res = await runRoute('get', '/factura-disponible', { query: { prefijo: 'FV', numero: '99' } });
    expect(res.body.data).toEqual({ disponible: true });
  });

  it('no consulta la base si falta prefijo o número', async () => {
    const res = await runRoute('get', '/factura-disponible', { query: { prefijo: 'FV' } });
    expect(res.body.data).toEqual({ disponible: true });
    expect(mockConnection.query).not.toHaveBeenCalled();
  });
});
