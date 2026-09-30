import { describe, it, expect, vi, beforeEach } from 'vitest';

// productos.codigo_atc es FK contra clasificacion_atc, y ese catálogo local
// está incompleto. El auto-completado de la jerarquía ATC faltante existía
// solo en backfillCodigoAtcFromHs, así que crear o editar un MX a mano con un
// código que no figuraba en el catálogo (ej. "R06AX26", bilastina) reventaba
// con el error crudo de MySQL: "Cannot add or update a child row: a foreign
// key constraint fails (`akripharmacy`.`productos`, CONSTRAINT `fk_prod_atc`
// FOREIGN KEY (`codigo_atc`) REFERENCES `clasificacion_atc` (`codigo_atc`))".
// createProduct/updateProduct deben completar el catálogo antes de guardar.
vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));

const mockHsConnection = { query: vi.fn(), release: vi.fn() };
vi.mock('../../config/hs-db.js', () => ({
  hsPool: { getConnection: vi.fn(async () => mockHsConnection) }
}));

const { query } = await import('../../config/db.js');
const { createProduct, updateProduct } = await import('../product.service.js');

const FK_ERROR =
  'Cannot add or update a child row: a foreign key constraint fails ' +
  '(`akripharmacy`.`productos`, CONSTRAINT `fk_prod_atc` FOREIGN KEY (`codigo_atc`) ' +
  'REFERENCES `clasificacion_atc` (`codigo_atc`))';

// Enruta por SQL en vez de por orden de llamada: así los tests no dependen
// del número de queries auxiliares de getProductById/saveTrace.
function routeQueries({ atcExistentes = [], productoActual = null } = {}) {
  const catalogo = new Set(atcExistentes);
  const spy = {
    atcInsertados: [],     // [{ codigo, nivel, descripcion, codigo_padre }]
    productoInsert: null,  // params del INSERT INTO productos
    productoUpdate: null   // params del UPDATE productos
  };

  query.mockImplementation(async (sql, params = []) => {
    if (/FROM parametros_sistema/.test(sql)) return [{ valor: 'medicamento' }];

    if (/SELECT codigo_atc FROM clasificacion_atc/.test(sql)) {
      return [...catalogo].map((codigo_atc) => ({ codigo_atc }));
    }
    if (/INSERT IGNORE INTO clasificacion_atc/.test(sql)) {
      const [codigo, nivel, descripcion, , codigo_padre] = params;
      // Refleja la FK auto-referencial real: el padre debe existir en la
      // tabla en el momento de insertar el hijo.
      if (codigo_padre != null && !catalogo.has(codigo_padre)) {
        throw new Error(`FK clasificacion_atc.codigo_padre: "${codigo_padre}" no existe al insertar "${codigo}"`);
      }
      catalogo.add(codigo);
      spy.atcInsertados.push({ codigo, nivel, descripcion, codigo_padre });
      return { affectedRows: 1 };
    }

    if (/INSERT INTO productos/.test(sql)) {
      spy.productoInsert = params;
      const codigoAtc = params[14];
      if (codigoAtc != null && !catalogo.has(codigoAtc)) throw new Error(FK_ERROR);
      return { insertId: 77 };
    }
    if (/UPDATE productos SET/.test(sql)) {
      spy.productoUpdate = params;
      const codigoAtc = params[12];
      if (codigoAtc != null && !catalogo.has(codigoAtc)) throw new Error(FK_ERROR);
      return { affectedRows: 1 };
    }

    // ensureProductExists / getProductById
    if (/SELECT id_producto, id_medicamento_hs/.test(sql)) {
      return [productoActual ?? { id_producto: 77, sku: 'MX1052', nombre_comercial: 'BILAXTEN', codigo_atc: null }];
    }
    return [];
  });

  return spy;
}

const PAYLOAD_BILASTINA = {
  sku: 'MX1052',
  nombre_comercial: 'BILAXTEN',
  tipo_producto: 'medicamento',
  codigo_atc: 'R06AX26'
};

describe('createProduct completa clasificacion_atc antes de guardar (fk_prod_atc)', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
    mockHsConnection.query.mockResolvedValue([[]]);
  });

  it('guarda un producto con un código ATC ausente del catálogo, sin violar la FK', async () => {
    const spy = routeQueries({ atcExistentes: [] });

    await expect(createProduct(PAYLOAD_BILASTINA)).resolves.toBeTruthy();

    expect(spy.productoInsert[14]).toBe('R06AX26');
  });

  it('inserta toda la cadena de ancestros ATC, por nivel y con el codigo_padre correcto', async () => {
    const spy = routeQueries({ atcExistentes: [] });

    await createProduct(PAYLOAD_BILASTINA);

    expect(spy.atcInsertados).toEqual([
      { codigo: 'R', nivel: 1, descripcion: expect.any(String), codigo_padre: null },
      { codigo: 'R06', nivel: 2, descripcion: expect.any(String), codigo_padre: 'R' },
      { codigo: 'R06A', nivel: 3, descripcion: expect.any(String), codigo_padre: 'R06' },
      { codigo: 'R06AX', nivel: 4, descripcion: expect.any(String), codigo_padre: 'R06A' },
      { codigo: 'R06AX26', nivel: 5, descripcion: expect.any(String), codigo_padre: 'R06AX' }
    ]);
  });

  it('no reinserta los niveles que ya existen en el catálogo', async () => {
    const spy = routeQueries({ atcExistentes: ['R', 'R06'] });

    await createProduct(PAYLOAD_BILASTINA);

    expect(spy.atcInsertados.map((r) => r.codigo)).toEqual(['R06A', 'R06AX', 'R06AX26']);
  });

  it('no toca el catálogo cuando el código ATC ya existe completo', async () => {
    const spy = routeQueries({ atcExistentes: ['R', 'R06', 'R06A', 'R06AX', 'R06AX26'] });

    await createProduct(PAYLOAD_BILASTINA);

    expect(spy.atcInsertados).toEqual([]);
    expect(spy.productoInsert[14]).toBe('R06AX26');
  });

  it('describe el código hoja con el nombre del producto y lo marca como pendiente de revisar contra WHO ATC', async () => {
    const spy = routeQueries({ atcExistentes: [] });

    await createProduct(PAYLOAD_BILASTINA);

    const hoja = spy.atcInsertados.at(-1);
    expect(hoja.descripcion).toContain('BILAXTEN');
    expect(hoja.descripcion).toContain('pendiente de revisar contra el estándar WHO ATC oficial');
    // No debe atribuirse a HealthSphere: este código se digitó en el maestro.
    expect(hoja.descripcion).not.toContain('HealthSphere');
  });

  it('normaliza el código (trim) para que no quede desalineado de su jerarquía', async () => {
    const spy = routeQueries({ atcExistentes: [] });

    await createProduct({ ...PAYLOAD_BILASTINA, codigo_atc: '  R06AX26  ' });

    expect(spy.productoInsert[14]).toBe('R06AX26');
    expect(spy.atcInsertados.map((r) => r.codigo)).toEqual(['R', 'R06', 'R06A', 'R06AX', 'R06AX26']);
  });

  it('guarda NULL y no consulta el catálogo cuando no se informa código ATC', async () => {
    const spy = routeQueries({ atcExistentes: [] });

    await createProduct({ sku: 'MX1', nombre_comercial: 'SIN ATC', tipo_producto: 'medicamento' });

    expect(spy.productoInsert[14]).toBeNull();
    expect(spy.atcInsertados).toEqual([]);
    expect(query.mock.calls.some(([sql]) => /clasificacion_atc/.test(sql))).toBe(false);
  });

  it('trata una cadena de solo espacios como sin código ATC', async () => {
    const spy = routeQueries({ atcExistentes: [] });

    await createProduct({ ...PAYLOAD_BILASTINA, codigo_atc: '   ' });

    expect(spy.productoInsert[14]).toBeNull();
    expect(spy.atcInsertados).toEqual([]);
  });

  it('acepta un código fuera del formato WHO ATC sin bloquear el producto', async () => {
    // HS trae códigos sucios (ej. "902018", sin letra inicial); el criterio ya
    // fijado en el backfill es guardarlos igual, no bloquear el MX.
    const spy = routeQueries({ atcExistentes: [] });

    await createProduct({ ...PAYLOAD_BILASTINA, codigo_atc: '902018' });

    expect(spy.productoInsert[14]).toBe('902018');
    expect(spy.atcInsertados.at(-1).codigo).toBe('902018');
  });
});

describe('updateProduct completa clasificacion_atc antes de guardar (fk_prod_atc)', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
    mockHsConnection.query.mockResolvedValue([[]]);
  });

  it('completa el catálogo al editar un producto y asignarle un ATC nuevo', async () => {
    const spy = routeQueries({
      atcExistentes: [],
      productoActual: { id_producto: 77, sku: 'MX1052', nombre_comercial: 'BILAXTEN', codigo_atc: null, tipo_producto: 'medicamento' }
    });

    await updateProduct(77, { codigo_atc: 'R06AX26' });

    expect(spy.atcInsertados.map((r) => r.codigo)).toEqual(['R', 'R06', 'R06A', 'R06AX', 'R06AX26']);
    expect(spy.productoUpdate[12]).toBe('R06AX26');
  });

  it('conserva el ATC actual del producto cuando la edición no lo toca', async () => {
    const spy = routeQueries({
      atcExistentes: ['R', 'R06', 'R06A', 'R06AX', 'R06AX26'],
      productoActual: { id_producto: 77, sku: 'MX1052', nombre_comercial: 'BILAXTEN', codigo_atc: 'R06AX26', tipo_producto: 'medicamento' }
    });

    await updateProduct(77, { nombre_comercial: 'BILAXTEN 20 MG' });

    expect(spy.productoUpdate[12]).toBe('R06AX26');
    expect(spy.atcInsertados).toEqual([]);
  });
});
