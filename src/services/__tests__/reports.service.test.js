import { describe, it, expect, vi, beforeEach } from 'vitest';

// Informes: se le agregaron filtros de Fecha y Sede/Bodega a los exports de
// compras e inventario (antes solo tenían "search" de texto libre). Estas
// pruebas fijan que los filtros realmente lleguen al SQL con los parámetros
// correctos — un error de orden de placeholders aquí generaría reportes
// silenciosamente mal filtrados (ej. mezclando fechas de otra sede).
vi.mock('../../config/db.js', () => ({
  pool: {},
  query: vi.fn(async () => [])
}));
vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../audit.service.js', () => ({ writeAudit: vi.fn(async () => {}) }));
vi.mock('../dashboard.service.js', () => ({ getSummary: vi.fn(async () => ({})) }));
vi.mock('../inventory.service.js', () => ({ listStock: vi.fn(async () => []) }));
vi.mock('../formulacion-hs.service.js', () => ({
  getDxPorIdMedFormulacion: vi.fn(async () => ({})),
  getPrescriptorPorIdFormulacion: vi.fn(async () => ({}))
}));

const { query } = await import('../../config/db.js');
const { listStock } = await import('../inventory.service.js');
const { getDxPorIdMedFormulacion, getPrescriptorPorIdFormulacion } = await import('../formulacion-hs.service.js');
const {
  createPurchasesExport,
  createInventoryExport,
  createEntradasExport,
  createSalidasExport,
  createIngresosExport,
  createDevolucionesExport,
  createActasExport,
  createDispensingExport,
  createMaestroExport,
  createProductMovementsExport,
  createRipsAmExport,
  createPendientesExport
} = await import('../reports.service.js');

describe('reports.service — filtros de Informes (Fecha / Sede-Bodega)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createPurchasesExport', () => {
    it('sin filtros no agrega condiciones de fecha ni sede al SQL', async () => {
      await createPurchasesExport('json', '', 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).not.toContain('oc.fecha >=');
      expect(sql).not.toContain('oc.fecha <=');
      expect(sql).not.toContain('oc.id_sede = ?');
      expect(params).toEqual([]);
    });

    it('manda desde/hasta/id_sede como condiciones AND con sus parámetros en orden', async () => {
      await createPurchasesExport('json', '', 1, { desde: '2026-09-01', hasta: '2026-09-30', idSede: 3 });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('oc.fecha >= ?');
      expect(sql).toContain('oc.fecha <= ?');
      expect(sql).toContain('oc.id_sede = ?');
      expect(params).toEqual(['2026-09-01', '2026-09-30', 3]);

      // El segundo query (detalle) debe usar EXACTAMENTE los mismos params,
      // porque reutiliza el mismo `where` armado una sola vez.
      const [sqlDetalle, paramsDetalle] = query.mock.calls[1];
      expect(sqlDetalle).toContain('oc.id_sede = ?');
      expect(paramsDetalle).toEqual(['2026-09-01', '2026-09-30', 3]);
    });

    it('combina el texto de búsqueda con los filtros de fecha/sede en el mismo WHERE', async () => {
      await createPurchasesExport('json', 'OC-0001', 1, { desde: '2026-09-01', idSede: 3 });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('oc.numero_oc LIKE ?');
      expect(sql).toContain('oc.fecha >= ?');
      expect(sql).toContain('oc.id_sede = ?');
      expect(params).toEqual(['%OC-0001%', '%OC-0001%', '%OC-0001%', '%OC-0001%', '%OC-0001%', '2026-09-01', 3]);
    });
  });

  describe('createInventoryExport', () => {
    it('pasa id_sede a listStock (idAlmacen y tipoProducto quedan sin filtrar)', async () => {
      await createInventoryExport('json', 'GLIFORMIN', 1, 7);

      expect(listStock).toHaveBeenCalledWith('GLIFORMIN', null, null, 7);
    });

    it('sin sede, pasa null (no filtra por sede)', async () => {
      await createInventoryExport('json', '', 1);

      expect(listStock).toHaveBeenCalledWith('', null, null, null);
    });
  });

  // "Entradas" y "Salidas" son el consolidado de lo que registran las
  // pantallas Movimiento de Entrada / Movimiento de Salida — NO todo
  // movimientos_inventario (eso mezclaría compras/dispensación/traslados,
  // que ya son sus propios informes). Se filtran por los mismos tipos que
  // ofrecen esas pantallas (parametros_sistema).
  describe('createEntradasExport / createSalidasExport', () => {
    function mockTiposYFilas(tipos, filas = []) {
      query.mockImplementation(async (sql) => {
        if (sql.includes('FROM parametros_sistema')) {
          return tipos.map((valor) => ({ valor }));
        }
        return filas;
      });
    }

    it('createEntradasExport consulta el grupo tipo_movimiento_entrada y filtra por esos tipos', async () => {
      mockTiposYFilas(['bonificacion', 'inventario_sobrante_fisico', 'OTRO']);

      await createEntradasExport('json', {}, 1);

      const tiposCall = query.mock.calls.find(([sql]) => sql.includes('FROM parametros_sistema'));
      expect(tiposCall[1]).toEqual(['tipo_movimiento_entrada']);

      const movCall = query.mock.calls.find(([sql]) => sql.includes('FROM movimientos_inventario'));
      expect(movCall[0]).toContain('m.id_almacen_destino');
      expect(movCall[0]).toContain('m.tipo IN (?,?,?)');
      expect(movCall[1]).toEqual(['bonificacion', 'inventario_sobrante_fisico', 'OTRO']);
    });

    it('createSalidasExport consulta el grupo tipo_movimiento_salida y usa el almacén de origen', async () => {
      mockTiposYFilas(['inventario_faltante_fisico', 'CONSUMO']);

      await createSalidasExport('json', {}, 1);

      const tiposCall = query.mock.calls.find(([sql]) => sql.includes('FROM parametros_sistema'));
      expect(tiposCall[1]).toEqual(['tipo_movimiento_salida']);

      const movCall = query.mock.calls.find(([sql]) => sql.includes('FROM movimientos_inventario'));
      expect(movCall[0]).toContain('m.id_almacen_origen');
      expect(movCall[1]).toEqual(['inventario_faltante_fisico', 'CONSUMO']);
    });

    it('agrega desde/hasta/id_sede después de los tipos, en ese orden', async () => {
      mockTiposYFilas(['CONSUMO']);

      await createSalidasExport('json', { desde: '2026-09-01', hasta: '2026-09-30', idSede: 3 }, 1);

      const movCall = query.mock.calls.find(([sql]) => sql.includes('FROM movimientos_inventario'));
      expect(movCall[0]).toContain('m.fecha_hora >= ?');
      expect(movCall[0]).toContain('m.fecha_hora <= ?');
      expect(movCall[0]).toContain('a.id_sede = ?');
      expect(movCall[1]).toEqual(['CONSUMO', '2026-09-01 00:00:00', '2026-09-30 23:59:59', 3]);
    });

    it('cuando el grupo de parámetros está vacío, no consulta movimientos y devuelve un reporte vacío', async () => {
      mockTiposYFilas([]);

      await createEntradasExport('json', {}, 1);

      const movCall = query.mock.calls.find(([sql]) => sql.includes('FROM movimientos_inventario'));
      expect(movCall).toBeUndefined();
    });
  });

  // "Ingresos", "Devoluciones" y "Actas de recepción" vienen de la misma
  // tabla `ingresos` — una devolución es un ingreso con referencia "DEV-%",
  // igual que lo distingue ingresos.routes.js al registrarla. Estas pruebas
  // fijan que cada informe filtre por el WHERE correcto (o ninguno, en el
  // caso de Actas, que consolida ambos).
  describe('createIngresosExport / createDevolucionesExport / createActasExport', () => {
    it('createIngresosExport excluye las referencias DEV-', async () => {
      await createIngresosExport('json', {}, 1);

      const headerCall = query.mock.calls.find(([sql]) => sql.includes('FROM ingresos i'));
      expect(headerCall[0]).toContain("i.referencia NOT LIKE 'DEV-%'");
    });

    it('createDevolucionesExport solo trae referencias DEV-', async () => {
      await createDevolucionesExport('json', {}, 1);

      const headerCall = query.mock.calls.find(([sql]) => sql.includes('FROM ingresos i'));
      expect(headerCall[0]).toContain("i.referencia LIKE 'DEV-%'");
      expect(headerCall[0]).not.toContain("NOT LIKE 'DEV-%'");
    });

    it('createActasExport no filtra por tipo de referencia (consolida ingresos y devoluciones)', async () => {
      await createActasExport('json', {}, 1);

      const headerCall = query.mock.calls.find(([sql]) => sql.includes('FROM ingresos i'));
      expect(headerCall[0]).not.toContain('DEV-%');
    });

    it('aplica desde/hasta/id_sede en la consulta de ingresos', async () => {
      await createIngresosExport('json', { desde: '2026-09-01', hasta: '2026-09-30', idSede: 3 }, 1);

      const headerCall = query.mock.calls.find(([sql]) => sql.includes('FROM ingresos i'));
      expect(headerCall[0]).toContain('i.fecha_recepcion >= ?');
      expect(headerCall[0]).toContain('i.fecha_recepcion <= ?');
      expect(headerCall[0]).toContain('a.id_sede = ?');
      expect(headerCall[1]).toEqual(['2026-09-01', '2026-09-30', 3]);

      const detailCall = query.mock.calls.find(([sql]) => sql.includes('FROM ingresos_items'));
      expect(detailCall[1]).toEqual(['2026-09-01', '2026-09-30', 3]);
    });
  });

  // "Dispensación" corre sobre dispensacion_hs_control (el flujo real de
  // HealthSphere), NUNCA sobre las tablas legacy dispensaciones/
  // dispensaciones_detalle de un flujo manual que ya no se usa. Estas
  // pruebas fijan que se consulte la tabla correcta y que el filtro de
  // fecha use fecha_formulacion en la cabecera y fecha_hora en el detalle
  // (las entregas reales), tal como getHistorialEntregas() distingue
  // formulado de dispensado.
  describe('createDispensingExport', () => {
    it('consulta dispensacion_hs_control, no las tablas legacy de dispensaciones', async () => {
      await createDispensingExport('json', {}, 1);

      const headerCall = query.mock.calls.find(([sql]) => sql.includes('FROM dispensacion_hs_control'));
      expect(headerCall).toBeDefined();

      const legacyCall = query.mock.calls.find(([sql]) => sql.includes('FROM dispensaciones d'));
      expect(legacyCall).toBeUndefined();
    });

    it('el detalle de entregas viene de movimientos_inventario con referencia DISPENSACION_HS_CONTROL', async () => {
      await createDispensingExport('json', {}, 1);

      const detailCall = query.mock.calls.find(([sql]) => sql.includes('INNER JOIN dispensacion_hs_control c ON c.id = m.referencia_id'));
      expect(detailCall[0]).toContain("m.referencia_tipo = 'DISPENSACION_HS_CONTROL'");
      expect(detailCall[0]).toContain('ANULACION_DISPENSACION_HS');
      expect(detailCall[0]).toContain('anulado');
    });

    it('aplica desde/hasta a fecha_formulacion en cabecera y a fecha_hora en el detalle', async () => {
      await createDispensingExport('json', { desde: '2026-09-01', hasta: '2026-09-30', idSede: 3 }, 1);

      const headerCall = query.mock.calls.find(([sql]) => sql.includes('FROM dispensacion_hs_control'));
      expect(headerCall[0]).toContain('c.fecha_formulacion >= ?');
      expect(headerCall[0]).toContain('c.fecha_formulacion <= ?');
      expect(headerCall[1]).toEqual(['2026-09-01', '2026-09-30', 3]);

      const detailCall = query.mock.calls.find(([sql]) => sql.includes('INNER JOIN dispensacion_hs_control c ON c.id = m.referencia_id'));
      expect(detailCall[0]).toContain('m.fecha_hora >= ?');
      expect(detailCall[0]).toContain('m.fecha_hora <= ?');
      expect(detailCall[1]).toEqual(['2026-09-01 00:00:00', '2026-09-30 23:59:59', 3]);
    });

    it('acepta un string plano de search para no romper la página de Reportes vieja', async () => {
      await createDispensingExport('json', 'GLIFORMIN', 1);

      const headerCall = query.mock.calls.find(([sql]) => sql.includes('FROM dispensacion_hs_control'));
      expect(headerCall[0]).toContain('c.nombre_paciente LIKE ?');
      expect(headerCall[1]).toEqual(['%GLIFORMIN%', '%GLIFORMIN%', '%GLIFORMIN%']);
    });
  });

  // "Listado maestro": el catálogo es global (no tiene id_sede propio), así
  // que el filtro de Sede/Bodega se resuelve por EXISTS contra
  // lotes/existencias/almacenes — igual que listStock() para inventario.
  describe('createMaestroExport', () => {
    it('sin filtros no agrega condiciones al SQL', async () => {
      await createMaestroExport('json', {}, 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('FROM productos p');
      expect(sql).not.toContain('WHERE');
      expect(params).toEqual([]);
    });

    it('el filtro de sede usa EXISTS contra lotes/existencias/almacenes, no una columna directa', async () => {
      await createMaestroExport('json', { idSede: 3 }, 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('EXISTS (');
      expect(sql).toContain('a.id_sede = ?');
      expect(params).toEqual([3]);
    });

    it('aplica desde/hasta sobre fecha_creacion', async () => {
      await createMaestroExport('json', { desde: '2026-09-01', hasta: '2026-09-30' }, 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('p.fecha_creacion >= ?');
      expect(sql).toContain('p.fecha_creacion <= ?');
      expect(params).toEqual(['2026-09-01 00:00:00', '2026-09-30 23:59:59']);
    });
  });

  // "Movimientos por producto" es el historial COMPLETO de
  // movimientos_inventario de un MX (compras, dispensación, traslados,
  // ajustes) — a diferencia de "Entradas"/"Salidas" que solo cubren lo
  // registrado en esas dos pantallas puntuales. El filtro de sede debe
  // matchear el almacén de origen O el de destino, porque un traslado tiene
  // ambos.
  describe('createProductMovementsExport', () => {
    it('consulta todo movimientos_inventario sin filtrar por tipo', async () => {
      await createProductMovementsExport('json', {}, 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('FROM movimientos_inventario m');
      expect(sql).not.toContain('m.tipo IN');
      expect(params).toEqual([]);
    });

    it('el filtro de sede matchea almacén de origen O destino', async () => {
      await createProductMovementsExport('json', { idSede: 4 }, 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('(almO.id_sede = ? OR almD.id_sede = ?)');
      expect(params).toEqual([4, 4]);
    });

    it('aplica desde/hasta sobre fecha_hora', async () => {
      await createProductMovementsExport('json', { desde: '2026-09-01', hasta: '2026-09-30' }, 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('m.fecha_hora >= ?');
      expect(sql).toContain('m.fecha_hora <= ?');
      expect(params).toEqual(['2026-09-01 00:00:00', '2026-09-30 23:59:59']);
    });
  });

  // RIPS: solo se genera el archivo AM (medicamentos) sobre
  // dispensacion_hs_control, y SOLO lo realmente dispensado — nunca lo
  // pendiente/anulado, porque eso no se factura.
  describe('createRipsAmExport', () => {
    it('solo incluye renglones con cantidad_dispensada > 0', async () => {
      await createRipsAmExport('json', {}, 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('c.cantidad_dispensada > 0');
      expect(sql).toContain('FROM dispensacion_hs_control c');
      expect(params).toEqual([]);
    });

    it('aplica desde/hasta sobre fecha_dispensacion', async () => {
      await createRipsAmExport('json', { desde: '2026-09-01', hasta: '2026-09-30' }, 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('c.fecha_dispensacion >= ?');
      expect(sql).toContain('c.fecha_dispensacion <= ?');
      expect(params).toEqual(['2026-09-01 00:00:00', '2026-09-30 23:59:59']);
    });

    // El CIE-10 real solo vive en HealthSphere (texto libre "CODIGO-desc"
    // en fm.dx) — nunca en la base local, así que se trae en un segundo
    // viaje y se cruza por id_med_formulacion_hs. El "código de
    // habilitación" todavía no existe como dato real (no hay columna REPS
    // en `sedes`), así que por pedido explícito del usuario ese campo lleva
    // el NOMBRE de la sede mientras se carga el dato real.
    it('cruza el CIE-10 desde HealthSphere y usa el nombre de sede como código de habilitación', async () => {
      query.mockResolvedValueOnce([
        { id: 55, id_med_formulacion_hs: 501882, documento_paciente: '42080262', sede: 'SEDE MEDELLIN HEMOFILIA', cum: null }
      ]);
      getDxPorIdMedFormulacion.mockResolvedValueOnce({
        501882: { cie10: 'E109', dx_completo: 'E109-Diabetes mellitus insulinodependiente sin mencion de complicacion' }
      });

      const dataset = await createRipsAmExport('json', {}, 1);
      const data = JSON.parse(dataset.buffer.toString('utf8'));

      expect(getDxPorIdMedFormulacion).toHaveBeenCalledWith([501882]);
      expect(data.rows[0].diagnostico_cie10).toBe('E109');
      expect(data.rows[0].codigo_habilitacion).toBe('SEDE MEDELLIN HEMOFILIA');
    });

    it('arma el CUM con su consecutivo, usa el nombre de HS como descripción y la concentración de HS', async () => {
      query.mockResolvedValueOnce([
        {
          id: 56,
          id_med_formulacion_hs: 501883,
          documento_paciente: '42080262',
          sede: 'SEDE MEDELLIN HEMOFILIA',
          cum: '19963298',
          consecutivo_cum: 2,
          nombre_medicamento: 'LEFLUNOMIDA 20 MG TABLETA RECUBIERTA',
          concentracion: '20 MG (Maestro local — no debe usarse)'
        }
      ]);
      getDxPorIdMedFormulacion.mockResolvedValueOnce({
        501883: { cie10: 'M059', dx_completo: 'M059-...', concentracion_hs: '20 MG' }
      });

      const dataset = await createRipsAmExport('json', {}, 1);
      const data = JSON.parse(dataset.buffer.toString('utf8'));
      const row = data.rows[0];

      expect(row.cum_completo).toBe('19963298-2');
      expect(row.descripcion_producto).toBe('LEFLUNOMIDA 20 MG TABLETA RECUBIERTA');
      expect(row.concentracion_hs).toBe('20 MG');
      expect(row.tipo_medicamento).toBeNull();
    });

    it('usa fm.unidadDosificacion como unidad mínima cuando el medicamento NO tiene cálculo', async () => {
      query.mockResolvedValueOnce([
        { id: 57, id_med_formulacion_hs: 501884, sede: 'SEDE CALI', cantidad_dispensada: 30, unidad_medida: 'TABLETAS' }
      ]);
      getDxPorIdMedFormulacion.mockResolvedValueOnce({
        501884: { unidad_dosificacion_hs: 'TABLETA', forma_farmaceutica_hs: 'TABLETA RECUBIERTA', unidad_minima_dispensacion: 'TABLETA', temporalidad_hs: 'cada 6 horas durante 2 días' }
      });

      const dataset = await createRipsAmExport('json', {}, 1);
      const row = JSON.parse(dataset.buffer.toString('utf8')).rows[0];

      expect(row.forma_farmaceutica_hs).toBe('TABLETA RECUBIERTA');
      expect(row.unidad_minima_dispensacion).toBe('TABLETA');
      expect(row.cantidad_dispensada_rips).toBe(30);
      expect(row.temporalidad_hs).toBe('cada 6 horas durante 2 días');
    });

    // Corrección explícita del usuario: "Unidad de medida" en el RIPS debe
    // ser la MISMA que aparece en la ficha del MX en Maestro
    // (productos.unidad_medida, local) — NO la unidad de dosificación de
    // HealthSphere (esa solo se usa para "Unidad mínima de dispensación").
    it('"Unidad de medida" viene del Maestro local (productos.unidad_medida), no de HS', async () => {
      query.mockResolvedValueOnce([
        { id: 60, id_med_formulacion_hs: 501887, sede: 'SEDE CALI', unidad_medida: 'UNIDADES' }
      ]);
      getDxPorIdMedFormulacion.mockResolvedValueOnce({
        501887: { unidad_dosificacion_hs: 'TIRAS (esto NO debe salir)' }
      });

      const dataset = await createRipsAmExport('json', {}, 1);
      const row = JSON.parse(dataset.buffer.toString('utf8')).rows[0];

      expect(row.unidad_medida).toBe('UNIDADES');
    });

    // El médico prescriptor se resuelve por id_formulacion_hs (no por
    // id_med_formulacion_hs) porque es el mismo para todos los medicamentos
    // de una misma fórmula.
    it('cruza el médico prescriptor por id_formulacion_hs', async () => {
      query.mockResolvedValueOnce([
        { id: 58, id_formulacion_hs: 347537, id_med_formulacion_hs: 501885, sede: 'SEDE CALI' }
      ]);
      getPrescriptorPorIdFormulacion.mockResolvedValueOnce({
        347537: { tipo_documento_medico: '1', numero_documento_medico: '71717384' }
      });

      const dataset = await createRipsAmExport('json', {}, 1);
      const row = JSON.parse(dataset.buffer.toString('utf8')).rows[0];

      expect(getPrescriptorPorIdFormulacion).toHaveBeenCalledWith([347537]);
      expect(row.tipo_documento_medico).toBe('1');
      expect(row.numero_documento_medico).toBe('71717384');
    });

    it('formulaciones sin prescriptor enlazado quedan en null, no inventadas', async () => {
      query.mockResolvedValueOnce([
        { id: 59, id_formulacion_hs: 21, id_med_formulacion_hs: 501886, sede: 'SEDE CALI' }
      ]);
      getPrescriptorPorIdFormulacion.mockResolvedValueOnce({});

      const dataset = await createRipsAmExport('json', {}, 1);
      const row = JSON.parse(dataset.buffer.toString('utf8')).rows[0];

      expect(row.tipo_documento_medico).toBeNull();
      expect(row.numero_documento_medico).toBeNull();
    });
  });

  // Pendientes: solo cubre facturas GENERADAS (facturas.estado) — el sistema
  // no tiene ninguna fuente de datos de pagos todavía, así que no debe
  // inventarse una columna "pagado".
  describe('createPendientesExport', () => {
    it('consulta facturas + ventas, sin ninguna tabla de pagos', async () => {
      await createPendientesExport('json', {}, 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('FROM facturas f');
      expect(sql).toContain('INNER JOIN ventas v');
      expect(sql).not.toMatch(/pagad[ao]|fecha_pago/i);
      expect(params).toEqual([]);
    });

    it('aplica desde/hasta sobre fecha_emision y filtra por sede vía ventas', async () => {
      await createPendientesExport('json', { desde: '2026-09-01', hasta: '2026-09-30', idSede: 3 }, 1);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('f.fecha_emision >= ?');
      expect(sql).toContain('f.fecha_emision <= ?');
      expect(sql).toContain('v.id_sede = ?');
      expect(params).toEqual(['2026-09-01 00:00:00', '2026-09-30 23:59:59', 3]);
    });
  });
});
