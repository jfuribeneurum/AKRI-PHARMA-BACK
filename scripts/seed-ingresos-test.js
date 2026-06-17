/**
 * Crea 2 ingresos completos de prueba para testear el flujo de devolución.
 * Uso: node scripts/seed-ingresos-test.js
 */
import mysql from 'mysql2/promise';
import 'dotenv/config';

const pool = await mysql.createPool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTexto({ proveedor, nit, sede, bodega, orden, factura, items }) {
  const metaLines = [
    orden   ? `Orden: ${orden}`       : '',
    sede    ? `Sede: ${sede}`         : '',
    bodega  ? `Bodega: ${bodega}`     : '',
    proveedor ? `Proveedor: ${proveedor}` : '',
    nit     ? `NIT: ${nit}`           : '',
    factura ? `Factura: ${factura}`   : '',
  ].filter(Boolean).join('\n');

  const itemLines = items.map((item, idx) =>
    [
      `Item ${idx + 1}:`,
      `codigo=${item.codigo}`,
      `nombre=${item.nombre}`,
      `laboratorio=${item.laboratorio}`,
      `cantidad=${item.cantidad}`,
      `valor_unitario=${item.valor_unitario}`,
      `lote=${item.lote}`,
      `vencimiento=${item.vencimiento}`,
    ].join(' | ')
  ).join('\n');

  const primerNombre = items[0]?.nombre || 'Ingreso';
  return [primerNombre, metaLines, itemLines].filter(Boolean).join('\n');
}

async function columnExists(conn, table, column) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return row.cnt > 0;
}

async function tableExists(conn, table) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  return row.cnt > 0;
}

// ── Datos de los 2 ingresos ───────────────────────────────────────────────────

const INGRESOS = [
  {
    referencia:         'ING-SEBAS-TEST-001',
    prefijo_factura:    'FBY',
    numero_factura:     '20240387',
    fecha_recepcion:    '2024-11-15',
    numero_orden_compra:'OC-2024-0087',
    sede:               'SEDE PRINCIPAL',
    bodega:             'BODEGA CENTRAL',
    proveedor_nombre:   'BAYER S.A.S.',
    proveedor_nit:      '800.022.703-1',
    proveedor_contacto: 'Carlos Ramírez',
    proveedor_telefono: '601-3456789',
    proveedor_direccion:'Cra 7 # 35-20, Bogotá',
    estado:             'recibido',
    observaciones:      'Ingreso de prueba — Bayer noviembre 2024',
    items: [
      { codigo:'ASPIR100', nombre:'Aspirina 100mg Tabletas',      laboratorio:'Bayer', cantidad:200, valor_unitario:850,  lote:'LT-BAY-2410', vencimiento:'2026-10-31' },
      { codigo:'BACT400',  nombre:'Bactrim 400mg Tabletas',       laboratorio:'Bayer', cantidad:150, valor_unitario:1200, lote:'LT-BAY-2411', vencimiento:'2026-08-31' },
      { codigo:'CARDIO100',nombre:'Cardioaspirina 100mg Tabletas',laboratorio:'Bayer', cantidad:100, valor_unitario:2500, lote:'LT-BAY-2412', vencimiento:'2027-01-31' },
    ],
    total_bruto:    600000,
    total_descuento:0,
    subtotal_neto:  600000,
    total_iva:      0,
    total_ingreso:  600000,
  },
  {
    referencia:         'ING-SEBAS-TEST-002',
    prefijo_factura:    'FNV',
    numero_factura:     '20240154',
    fecha_recepcion:    '2024-11-28',
    numero_orden_compra:'OC-2024-0091',
    sede:               'SEDE NORTE',
    bodega:             'BODEGA SECUNDARIA',
    proveedor_nombre:   'NOVARTIS DE COLOMBIA S.A.',
    proveedor_nit:      '800.062.506-7',
    proveedor_contacto: 'María López',
    proveedor_telefono: '601-8901234',
    proveedor_direccion:'Av. El Dorado # 68C-61, Bogotá',
    estado:             'almacenado',
    observaciones:      'Ingreso de prueba — Novartis noviembre 2024',
    items: [
      { codigo:'VOLT50',  nombre:'Voltaren 50mg Tabletas',      laboratorio:'Novartis', cantidad:300, valor_unitario:1800, lote:'LT-NOV-2501', vencimiento:'2026-12-31' },
      { codigo:'DICLO75', nombre:'Diclofenaco 75mg Ampollas',   laboratorio:'Novartis', cantidad:120, valor_unitario:4500, lote:'LT-NOV-2502', vencimiento:'2025-06-30' },
    ],
    total_bruto:    1080000,
    total_descuento:0,
    subtotal_neto:  1080000,
    total_iva:      0,
    total_ingreso:  1080000,
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

const conn = await pool.getConnection();
try {
  // Verificar si las columnas nuevas ya existen
  const tienePrefijo    = await columnExists(conn, 'ingresos', 'prefijo_factura');
  const tieneItemsTable = await tableExists(conn, 'ingresos_items');

  if (!tienePrefijo) {
    console.log('⚠️  Las columnas nuevas de ingresos NO existen todavía.');
    console.log('   Reinicia el backend primero para que corra la migración automática.');
    console.log('   Luego vuelve a ejecutar este script.');
    process.exit(1);
  }

  for (const ing of INGRESOS) {
    // ¿Ya existe esta referencia?
    const [[existing]] = await conn.query(
      `SELECT id_ingreso FROM ingresos WHERE referencia = ? LIMIT 1`,
      [ing.referencia]
    );
    if (existing) {
      console.log(`ℹ  ${ing.referencia} ya existe (id=${existing.id_ingreso}), se omite.`);
      continue;
    }

    const productoTexto = buildTexto({
      proveedor: ing.proveedor_nombre,
      nit:       ing.proveedor_nit,
      sede:      ing.sede,
      bodega:    ing.bodega,
      orden:     ing.numero_orden_compra,
      factura:   `${ing.prefijo_factura}${ing.numero_factura}`,
      items:     ing.items,
    });

    const cantidadTotal = ing.items.reduce((s, i) => s + i.cantidad, 0);

    const [result] = await conn.query(`
      INSERT INTO ingresos (
        referencia, producto, cantidad, lote, fecha_vencimiento, estado,
        fecha_ingreso,
        prefijo_factura, numero_factura, cufe, fecha_recepcion, observaciones,
        numero_orden_compra, sede, bodega,
        proveedor_nombre, proveedor_nit, proveedor_contacto, proveedor_telefono, proveedor_direccion,
        total_bruto, total_descuento, subtotal_neto, total_iva, total_ingreso
      ) VALUES (
        ?, ?, ?, NULL, NULL, ?,
        NOW(),
        ?, ?, NULL, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `, [
      ing.referencia, productoTexto, cantidadTotal, ing.estado,
      ing.prefijo_factura, ing.numero_factura, ing.fecha_recepcion, ing.observaciones,
      ing.numero_orden_compra, ing.sede, ing.bodega,
      ing.proveedor_nombre, ing.proveedor_nit, ing.proveedor_contacto, ing.proveedor_telefono, ing.proveedor_direccion,
      ing.total_bruto, ing.total_descuento, ing.subtotal_neto, ing.total_iva, ing.total_ingreso,
    ]);

    const ingresoId = result.insertId;
    console.log(`✓ Creado ${ing.referencia} (id=${ingresoId})`);

    if (tieneItemsTable) {
      for (const item of ing.items) {
        await conn.query(`
          INSERT INTO ingresos_items (
            id_ingreso, codigo, nombre, laboratorio,
            cantidad, valor_unitario, descuento_pct, descuento_valor, iva,
            lote, fecha_vencimiento
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
        `, [
          ingresoId,
          item.codigo, item.nombre, item.laboratorio,
          item.cantidad, item.valor_unitario,
          item.lote, item.vencimiento,
        ]);
      }
      console.log(`  └─ ${ing.items.length} items insertados en ingresos_items`);
    } else {
      console.log('  └─ Tabla ingresos_items no existe aún (se creará al reiniciar el backend)');
    }
  }

  console.log('\n✅ Listo. Abre la página de Devolución de pedido y busca ING-SEBAS-TEST-001 o ING-SEBAS-TEST-002.');
} finally {
  conn.release();
  await pool.end();
}
