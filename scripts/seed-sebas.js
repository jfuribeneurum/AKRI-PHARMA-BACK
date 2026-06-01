/**
 * Seed: 10 Órdenes de Compra Sebas + 10 Ingresos Sebas relacionados
 * Uso: node scripts/seed-sebas.js
 */
import { pool } from '../src/config/db.js';

// ─── Laboratorios / proveedores ──────────────────────────────────────────────
const PROVEEDORES = [
  { codigo: 'TMQ001', nombre: 'Tecnoquímicas S.A.',       nit: '890900608-3', ciudad: 'Cali' },
  { codigo: 'BAY001', nombre: 'Bayer Colombia S.A.',       nit: '860502596-5', ciudad: 'Bogotá' },
  { codigo: 'PFZ001', nombre: 'Pfizer Colombia S.A.S.',    nit: '800023873-2', ciudad: 'Bogotá' },
  { codigo: 'ABT001', nombre: 'Abbott Laboratories S.A.',  nit: '890901395-1', ciudad: 'Bogotá' },
  { codigo: 'LFC001', nombre: 'Lafrancol S.A.',            nit: '890300446-7', ciudad: 'Cali' },
];

// ─── Productos farmacéuticos ──────────────────────────────────────────────────
const PRODUCTOS = [
  { sku: 'TMQ-AMX500',  nombre: 'Amoxicilina 500mg',          laboratorio: 'Tecnoquímicas', precio: 1250 },
  { sku: 'TMQ-IBP400',  nombre: 'Ibuprofeno 400mg',           laboratorio: 'Tecnoquímicas', precio:  850 },
  { sku: 'BAY-ASP100',  nombre: 'Aspirina 100mg',             laboratorio: 'Bayer',         precio:  620 },
  { sku: 'BAY-CIP500',  nombre: 'Ciprofloxacino 500mg',       laboratorio: 'Bayer',         precio: 2300 },
  { sku: 'PFZ-ATR20',   nombre: 'Atorvastatina 20mg',         laboratorio: 'Pfizer',        precio: 1800 },
  { sku: 'PFZ-LOS50',   nombre: 'Losartán 50mg',              laboratorio: 'Pfizer',        precio: 1550 },
  { sku: 'ABT-MET850',  nombre: 'Metformina 850mg',           laboratorio: 'Abbott',        precio:  970 },
  { sku: 'ABT-ACE500',  nombre: 'Acetaminofén 500mg',         laboratorio: 'Abbott',        precio:  480 },
  { sku: 'LFC-OME20',   nombre: 'Omeprazol 20mg',             laboratorio: 'Lafrancol',     precio: 1100 },
  { sku: 'LFC-SAL100',  nombre: 'Salbutamol Inhalador 100mcg',laboratorio: 'Lafrancol',     precio: 8500 },
  { sku: 'TMQ-CLF4',    nombre: 'Clorfenamina 4mg',           laboratorio: 'Tecnoquímicas', precio:  380 },
  { sku: 'BAY-DEX4',    nombre: 'Dexametasona 4mg/mL Amp.',   laboratorio: 'Bayer',         precio: 3200 },
];

// ─── Definición de las 10 OCs con sus items ───────────────────────────────────
// Se construye con índices de PRODUCTOS y PROVEEDORES (0-based)
const OC_DATA = [
  {
    numero_oc: 'OC-SEBAS-2026-001', prov_idx: 0, estado: 'aprobada',
    observaciones: 'Pedido mensual antibióticos y analgésicos',
    items: [
      { prod_idx: 0, cantidad: 500, precio_unitario: 1250 },
      { prod_idx: 1, cantidad: 300, precio_unitario:  850 },
      { prod_idx: 10, cantidad: 200, precio_unitario:  380 },
    ],
  },
  {
    numero_oc: 'OC-SEBAS-2026-002', prov_idx: 1, estado: 'aprobada',
    observaciones: 'Reposición cardiovasculares Bayer',
    items: [
      { prod_idx: 2, cantidad: 1000, precio_unitario:  620 },
      { prod_idx: 3, cantidad:  150, precio_unitario: 2300 },
    ],
  },
  {
    numero_oc: 'OC-SEBAS-2026-003', prov_idx: 2, estado: 'aprobada',
    observaciones: 'Pedido estatinas y antihipertensivos',
    items: [
      { prod_idx: 4, cantidad: 400, precio_unitario: 1800 },
      { prod_idx: 5, cantidad: 600, precio_unitario: 1550 },
    ],
  },
  {
    numero_oc: 'OC-SEBAS-2026-004', prov_idx: 3, estado: 'aprobada',
    observaciones: 'Antidiabéticos y analgésicos Abbott',
    items: [
      { prod_idx: 6, cantidad: 350, precio_unitario:  970 },
      { prod_idx: 7, cantidad: 800, precio_unitario:  480 },
    ],
  },
  {
    numero_oc: 'OC-SEBAS-2026-005', prov_idx: 4, estado: 'aprobada',
    observaciones: 'Protectores gástricos e inhaladores',
    items: [
      { prod_idx: 8, cantidad: 500, precio_unitario: 1100 },
      { prod_idx: 9, cantidad:  80, precio_unitario: 8500 },
    ],
  },
  {
    numero_oc: 'OC-SEBAS-2026-006', prov_idx: 0, estado: 'aprobada',
    observaciones: 'Reposición antibióticos urgente',
    items: [
      { prod_idx: 0, cantidad: 200, precio_unitario: 1250 },
      { prod_idx: 3, cantidad: 100, precio_unitario: 2300 },
    ],
  },
  {
    numero_oc: 'OC-SEBAS-2026-007', prov_idx: 1, estado: 'borrador',
    observaciones: 'Pedido inyectables Bayer — pendiente aprobación',
    items: [
      { prod_idx: 11, cantidad: 120, precio_unitario: 3200 },
      { prod_idx: 2,  cantidad: 500, precio_unitario:  620 },
    ],
  },
  {
    numero_oc: 'OC-SEBAS-2026-008', prov_idx: 2, estado: 'aprobada',
    observaciones: 'Cardioprotectores segundo trimestre',
    items: [
      { prod_idx: 4, cantidad: 300, precio_unitario: 1800 },
      { prod_idx: 5, cantidad: 400, precio_unitario: 1550 },
      { prod_idx: 8, cantidad: 200, precio_unitario: 1100 },
    ],
  },
  {
    numero_oc: 'OC-SEBAS-2026-009', prov_idx: 3, estado: 'aprobada',
    observaciones: 'Reposición inventario general Abbott',
    items: [
      { prod_idx: 6, cantidad: 200, precio_unitario:  970 },
      { prod_idx: 7, cantidad: 600, precio_unitario:  480 },
      { prod_idx: 10, cantidad: 300, precio_unitario:  380 },
    ],
  },
  {
    numero_oc: 'OC-SEBAS-2026-010', prov_idx: 4, estado: 'borrador',
    observaciones: 'Pedido inhaladores alta demanda — en revisión',
    items: [
      { prod_idx: 9, cantidad: 60, precio_unitario: 8500 },
      { prod_idx: 8, cantidad: 300, precio_unitario: 1100 },
    ],
  },
];

// ─── Fechas de vencimiento por lote ──────────────────────────────────────────
const LOTES = [
  'L2026A01', 'L2026A02', 'L2026B01', 'L2026B02', 'L2026C01',
  'L2026C02', 'L2026D01', 'L2026D02', 'L2026E01', 'L2026E02',
];
const VENCIMIENTOS = [
  '2027-12-31', '2027-06-30', '2028-03-31', '2027-09-30', '2028-12-31',
  '2027-03-31', '2028-06-30', '2027-12-31', '2028-09-30', '2027-06-30',
];
const FECHAS_INGRESO = [
  '2026-01-10', '2026-01-18', '2026-02-03', '2026-02-14', '2026-03-01',
  '2026-03-15', '2026-04-02', '2026-04-20', '2026-05-05', '2026-05-18',
];
const ESTADOS_ING = [
  'recibido','almacenado','recibido','almacenado','recibido',
  'almacenado','recibido','almacenado','recibido','almacenado',
];

// ─── Helper: calcular totales de una OC ──────────────────────────────────────
function calcTotales(items) {
  return items.reduce((acc, it) => {
    const sub = it.cantidad * it.precio_unitario;
    acc.subtotal += sub;
    acc.total    += sub;
    return acc;
  }, { subtotal: 0, impuestos: 0, total: 0 });
}

// ─── Helper: construir texto `producto` para ingresos ────────────────────────
function buildProductoText(oc, proveedorNombre, sedeNombre, productosList, lote, vencimiento) {
  const meta = [
    `Proveedor: ${proveedorNombre}`,
    `Sede: ${sedeNombre}`,
    `Orden: ${oc.numero_oc}`,
    `Laboratorio: ${productosList[oc.items[0].prod_idx]?.laboratorio || ''}`,
  ].join('\n');

  const itemLines = oc.items.map((it, idx) => {
    const prod = productosList[it.prod_idx];
    return `Item ${idx + 1}: codigo=${prod.sku} | nombre=${prod.nombre} | laboratorio=${prod.laboratorio} | lote=${lote} | vencimiento=${vencimiento} | cantidad=${it.cantidad} | valor_unitario=${it.precio_unitario}`;
  }).join('\n');

  return `${meta}\n${itemLines}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  const conn = await pool.getConnection();
  try {
    console.log('\n== Seed Sebas — Órdenes de Compra e Ingresos ==\n');

    // 1. Sede principal
    const [[sedePrincipal]] = await conn.query(
      `SELECT id_sede, nombre FROM sedes WHERE es_principal = 1 AND activo = 1 LIMIT 1`
    );
    if (!sedePrincipal) {
      console.error('ERROR: No existe sede principal activa. Crea una sede primero en la app.');
      process.exit(1);
    }
    console.log(`✓ Sede principal: ${sedePrincipal.nombre} (id=${sedePrincipal.id_sede})`);

    // 2. Proveedores — insertar si no existen
    const provIds = [];
    for (const prov of PROVEEDORES) {
      const [[existing]] = await conn.query(
        `SELECT id_proveedor FROM proveedores WHERE nit = ? OR codigo = ? LIMIT 1`,
        [prov.nit, prov.codigo]
      );
      if (existing) {
        provIds.push(existing.id_proveedor);
        console.log(`  · Proveedor ya existe: ${prov.nombre}`);
      } else {
        const [res] = await conn.query(
          `INSERT INTO proveedores
             (codigo, nombre, razon_social, nit, numero_identificacion, ciudad, activo)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          [prov.codigo, prov.nombre, prov.nombre, prov.nit, prov.nit, prov.ciudad]
        );
        provIds.push(res.insertId);
        console.log(`  + Proveedor creado: ${prov.nombre} (id=${res.insertId})`);
      }
    }

    // 3. Productos — insertar si no existen
    const prodIds = [];
    for (const prod of PRODUCTOS) {
      const [[existing]] = await conn.query(
        `SELECT id_producto FROM productos WHERE sku = ? LIMIT 1`, [prod.sku]
      );
      if (existing) {
        prodIds.push(existing.id_producto);
        console.log(`  · Producto ya existe: ${prod.nombre}`);
      } else {
        const [res] = await conn.query(
          `INSERT INTO productos (sku, nombre_comercial, principio_activo, precio_venta, activo)
           VALUES (?, ?, ?, ?, 1)`,
          [prod.sku, prod.nombre, prod.nombre, prod.precio]
        );
        prodIds.push(res.insertId);
        console.log(`  + Producto creado: ${prod.nombre} (id=${res.insertId})`);
      }
    }

    console.log('\n── Órdenes de Compra ────────────────────────────────────────');

    // 4. Órdenes de Compra + Detalle
    const ocIds = [];
    for (let i = 0; i < OC_DATA.length; i++) {
      const oc = OC_DATA[i];

      // Verificar si ya existe
      const [[existingOc]] = await conn.query(
        `SELECT id_oc FROM ordenes_compra WHERE numero_oc = ? LIMIT 1`, [oc.numero_oc]
      );
      if (existingOc) {
        ocIds.push(existingOc.id_oc);
        console.log(`  · OC ya existe: ${oc.numero_oc}`);
        continue;
      }

      const totales = calcTotales(oc.items);
      const [ocRes] = await conn.query(
        `INSERT INTO ordenes_compra
           (id_sede, numero_oc, fecha, id_proveedor, estado, subtotal, impuestos, total, observaciones)
         VALUES (?, ?, DATE_SUB(CURDATE(), INTERVAL ? DAY), ?, ?, ?, ?, ?, ?)`,
        [
          sedePrincipal.id_sede,
          oc.numero_oc,
          (10 - i) * 7,             // fechas escalonadas hacia atrás
          provIds[oc.prov_idx],
          oc.estado,
          totales.subtotal,
          totales.impuestos,
          totales.total,
          oc.observaciones,
        ]
      );
      const ocId = ocRes.insertId;
      ocIds.push(ocId);

      for (const it of oc.items) {
        await conn.query(
          `INSERT INTO ordenes_compra_detalle
             (id_oc, id_producto, cantidad, precio_unitario, descuento, impuesto)
           VALUES (?, ?, ?, ?, 0, 0)`,
          [ocId, prodIds[it.prod_idx], it.cantidad, it.precio_unitario]
        );
      }
      console.log(`  + OC creada: ${oc.numero_oc}  (${oc.items.length} items, total $${totales.total.toLocaleString()})`);
    }

    console.log('\n── Ingresos Sebas ───────────────────────────────────────────');

    // 5. Ingresos Sebas (uno por OC, con producto en texto estructurado)
    for (let i = 0; i < OC_DATA.length; i++) {
      const oc      = OC_DATA[i];
      const ref     = `ING-SEBAS-2026-${String(i + 1).padStart(3, '0')}`;
      const lote    = LOTES[i];
      const venDate = VENCIMIENTOS[i];
      const estado  = ESTADOS_ING[i];
      const prov    = PROVEEDORES[oc.prov_idx];
      const totalCantidad = oc.items.reduce((s, it) => s + it.cantidad, 0);

      // Verificar si ya existe
      const [[existingIng]] = await conn.query(
        `SELECT id_ingreso FROM ingresos WHERE referencia = ? LIMIT 1`, [ref]
      );
      if (existingIng) {
        console.log(`  · Ingreso ya existe: ${ref}`);
        continue;
      }

      const productoTexto = buildProductoText(oc, prov.nombre, sedePrincipal.nombre, PRODUCTOS, lote, venDate);

      await conn.query(
        `INSERT INTO ingresos
           (referencia, producto, cantidad, lote, fecha_vencimiento, estado, fecha_ingreso)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ref, productoTexto, totalCantidad, lote, venDate, estado, FECHAS_INGRESO[i]]
      );
      console.log(`  + Ingreso creado: ${ref} → ${oc.numero_oc}  estado=${estado}  cantidad=${totalCantidad}`);
    }

    console.log('\n== Seed completado exitosamente ==\n');
  } catch (err) {
    console.error('\nERROR en seed:', err.message);
    if (err.code) console.error('  Código MySQL:', err.code);
    process.exit(1);
  } finally {
    conn.release();
    await pool.end();
  }
}

run();
