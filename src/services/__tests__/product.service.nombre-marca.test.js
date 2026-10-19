import { describe, it, expect, vi, beforeEach } from 'vitest';

// nombre_marca ("Nombre comercial" en Maestro MX) nació vacío. nombre_comercial
// (ahora rotulado "Descripción") guardó históricamente dos cosas: la
// descripción de HealthSphere precargada al enlazar, o la marca que la
// farmacia tecleó encima (HUMIRA, EXFORGE…). backfillNombreMarcaFromHs
// rescata esa marca propia y, si no hay, usa la que trae HS — sin tocar
// nombre_comercial ni pisar lo que ya tenga nombre_marca.
vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));

const mockHsConnection = { query: vi.fn(), release: vi.fn() };
vi.mock('../../config/hs-db.js', () => ({
  hsPool: { getConnection: vi.fn(async () => mockHsConnection) }
}));

const { query } = await import('../../config/db.js');
const { backfillNombreMarcaFromHs, esMarcaPropia } = await import('../product.service.js');

// Casos tomados de los datos reales de pruebas.
const CANDIDATOS = [
  // Marca de HS, nombre_comercial = descripción HS
  { id_producto: 220, id_medicamento_hs: 878, sku: 'MX878', nombre_comercial: 'EMICIZUMAB 105 MG / 0.7 ML SOLUCION INYECTABLE' },
  // Mismo medicamento HS (DOLOFF en HS) pero cada laboratorio con su marca propia
  { id_producto: 6, id_medicamento_hs: 26, sku: 'MX26', nombre_comercial: 'DOLOFF' },
  { id_producto: 7, id_medicamento_hs: 26, sku: 'MX26', nombre_comercial: 'SINALGEN' },
  // Marca propia y HS sin marca
  { id_producto: 28, id_medicamento_hs: 126, sku: 'MX126', nombre_comercial: '  humira ' },
  // Descripción escrita con otro formato que la de HS: no es marca, y HS no trae marca
  { id_producto: 90, id_medicamento_hs: 300, sku: 'MX300', nombre_comercial: 'APIXABAN 2,5 MG TABLETA RECUBIERTA' },
  // Descripción idéntica a HS y HS sin marca: queda vacío
  { id_producto: 752, id_medicamento_hs: 31, sku: 'MX31', nombre_comercial: 'ACETAMINOFEN 500 MG TABLETA' }
];

const HS_ROWS = [
  { id: 878, medicamento: 'EMICIZUMAB 105 MG / 0.7 ML SOLUCION INYECTABLE', nombreComercial: ' HEMLIBRA ' },
  { id: 26, medicamento: 'ACETAMINOFEN 325 MG + HIDROCODONA 5 MG TABLETA', nombreComercial: 'DOLOFF' },
  { id: 126, medicamento: 'ADALIMUMAB 20 MG / 0.2 ML SOLUCION INYECTABLE', nombreComercial: null },
  { id: 300, medicamento: 'APIXABAN 2.5 MG TABLETA RECUBIERTA', nombreComercial: '' },
  { id: 31, medicamento: 'ACETAMINOFEN 500 MG TABLETA', nombreComercial: null }
];

function routeQueries(candidatos = CANDIDATOS) {
  const spy = { updates: [], traces: [] };
  query.mockImplementation(async (sql, params = []) => {
    if (/FROM productos\s+WHERE id_medicamento_hs IS NOT NULL/.test(sql)) return candidatos;
    if (/UPDATE productos SET nombre_marca/.test(sql)) {
      spy.updates.push(params);
      return { affectedRows: 1 };
    }
    if (/procesos_terminados_trazabilidad/.test(sql)) {
      spy.traces.push(params);
      return { insertId: 1 };
    }
    return [];
  });
  mockHsConnection.query.mockResolvedValue([HS_ROWS]);
  return spy;
}

describe('esMarcaPropia', () => {
  it('es marca cuando difiere de la descripción HS y no tiene dosis ni forma', () => {
    expect(esMarcaPropia('HUMIRA', 'ADALIMUMAB 40 MG / 0.4 ML SOLUCION INYECTABLE')).toBe(true);
    expect(esMarcaPropia('DOLEX FORTE', 'ACETAMINOFEN 500 MG + CAFEINA 65 MG TABLETA')).toBe(true);
  });

  it('no es marca si es igual a la descripción HS (sin importar mayúsculas ni espacios)', () => {
    expect(esMarcaPropia(' acetaminofen  500 mg tableta', 'ACETAMINOFEN 500 MG TABLETA')).toBe(false);
  });

  it('no es marca si es una descripción con otro formato (dosis o forma farmacéutica)', () => {
    expect(esMarcaPropia('APIXABAN 2,5 MG TABLETA RECUBIERTA', 'APIXABAN 2.5 MG TABLETA RECUBIERTA')).toBe(false);
    expect(esMarcaPropia('LORATADINA 5MG/5ML JARABE', 'LORATADINA 5 MG / 5 ML JARABE')).toBe(false);
    expect(esMarcaPropia('FACTOR XIII 250 UI POLVO PARA RECONTITUIR', 'FACTOR XIII 250 UI POLVO PARA RECONSTITUIR')).toBe(false);
  });

  it('no es marca si está vacío', () => {
    expect(esMarcaPropia('', 'X')).toBe(false);
    expect(esMarcaPropia(null, 'X')).toBe(false);
  });
});

describe('backfillNombreMarcaFromHs', () => {
  beforeEach(() => {
    query.mockReset();
    mockHsConnection.query.mockReset();
    mockHsConnection.release.mockReset();
  });

  it('usa la marca propia de nombre_comercial y, si no hay, la de HS', async () => {
    const spy = routeQueries();

    const res = await backfillNombreMarcaFromHs(9);

    expect(spy.updates).toEqual([
      ['HEMLIBRA', 220],  // de HS (recortada)
      ['DOLOFF', 6],      // propia
      ['SINALGEN', 7],    // propia: NO se le pone DOLOFF de HS
      ['humira', 28]      // propia (recortada, se respeta como se escribió)
    ]);
    expect(res).toMatchObject({ candidatos: 6, actualizados: 4, desde_nombre_comercial: 3, desde_hs: 1, dry_run: false });
    expect(res.muestra.map((m) => m.origen)).toEqual(['hs', 'nombre_comercial', 'nombre_comercial', 'nombre_comercial']);
  });

  it('deja vacíos los productos sin marca propia ni marca en HS', async () => {
    const spy = routeQueries();
    await backfillNombreMarcaFromHs();
    const tocados = spy.updates.map(([, id]) => id);
    expect(tocados).not.toContain(90);
    expect(tocados).not.toContain(752);
  });

  it('nunca modifica nombre_comercial (la descripción)', async () => {
    routeQueries();
    await backfillNombreMarcaFromHs();
    const escrituras = query.mock.calls.map(([sql]) => sql).filter((sql) => /UPDATE productos/.test(sql));
    expect(escrituras.length).toBeGreaterThan(0);
    for (const sql of escrituras) expect(sql).not.toMatch(/nombre_comercial\s*=/);
  });

  it('solo busca candidatos con nombre_marca vacío y el UPDATE lo vuelve a exigir', async () => {
    routeQueries();
    await backfillNombreMarcaFromHs();

    const sqls = query.mock.calls.map(([sql]) => sql);
    expect(sqls.find((sql) => /SELECT id_producto/.test(sql))).toMatch(/nombre_marca IS NULL OR TRIM\(nombre_marca\) = ''/);
    expect(sqls.find((sql) => /UPDATE productos SET nombre_marca/.test(sql))).toMatch(/AND \(nombre_marca IS NULL OR TRIM\(nombre_marca\) = ''\)/);
  });

  it('consulta HS una sola vez con ids sin repetir y libera la conexión', async () => {
    routeQueries();
    await backfillNombreMarcaFromHs();

    expect(mockHsConnection.query).toHaveBeenCalledTimes(1);
    expect(mockHsConnection.query.mock.calls[0][1]).toEqual([878, 26, 126, 300, 31]);
    expect(mockHsConnection.release).toHaveBeenCalledTimes(1);
  });

  it('registra la trazabilidad con el resumen', async () => {
    const spy = routeQueries();
    await backfillNombreMarcaFromHs(9);
    expect(spy.traces).toHaveLength(1);
    const payload = JSON.parse(spy.traces[0].at(-1));
    expect(payload).toEqual({ candidatos: 6, actualizados: 4, desde_nombre_comercial: 3, desde_hs: 1 });
  });

  it('dryRun reporta lo que cambiaría sin escribir ni trazar', async () => {
    const spy = routeQueries();

    const res = await backfillNombreMarcaFromHs(null, { dryRun: true });

    expect(spy.updates).toEqual([]);
    expect(spy.traces).toEqual([]);
    expect(res).toMatchObject({ candidatos: 6, actualizados: 4, dry_run: true });
  });

  it('no consulta HS cuando no hay candidatos (re-ejecutarlo no hace nada)', async () => {
    routeQueries([]);

    const res = await backfillNombreMarcaFromHs();

    expect(res).toEqual({ candidatos: 0, actualizados: 0, desde_nombre_comercial: 0, desde_hs: 0, dry_run: false, muestra: [] });
    expect(mockHsConnection.query).not.toHaveBeenCalled();
  });

  it('libera la conexión de HS aunque la consulta falle, sin escribir nada', async () => {
    const spy = routeQueries();
    mockHsConnection.query.mockRejectedValue(new Error('HS caído'));

    await expect(backfillNombreMarcaFromHs()).rejects.toThrow('HS caído');
    expect(mockHsConnection.release).toHaveBeenCalledTimes(1);
    expect(spy.updates).toEqual([]);
  });
});
