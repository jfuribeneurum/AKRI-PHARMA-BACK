/**
 * Seed de datos para probar movimientos de entrada y salida.
 * Crea lotes vinculados a productos reales y existencias con stock.
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
const conn = await pool.getConnection();

try {
  await conn.beginTransaction();

  // 1. Verificar productos disponibles
  const [productos] = await conn.query(
    'SELECT id_producto, nombre_comercial, sku FROM productos WHERE activo = 1 ORDER BY id_producto LIMIT 4'
  );
  if (productos.length === 0) throw new Error('No hay productos activos en la DB.');
  console.log(`Usando ${productos.length} productos: ${productos.map(p => p.nombre_comercial).join(', ')}`);

  // 2. Nada que limpiar — los lotes huérfanos no aparecen en listStock (INNER JOIN productos)

  // 3. Crear lotes de prueba vinculados a productos reales
  const lotes = [
    { id_producto: productos[0].id_producto, numero_lote: 'LOTE-TEST-A01', fecha_venc: '2027-03-15', costo: 8500,  precio: 12000, ubicacion: 1 },  // Anaquel A1
    { id_producto: productos[0].id_producto, numero_lote: 'LOTE-TEST-A02', fecha_venc: '2026-09-30', costo: 8200,  precio: 11500, ubicacion: 1 },  // Anaquel A1
    { id_producto: productos[1 % productos.length].id_producto, numero_lote: 'LOTE-TEST-B01', fecha_venc: '2027-06-01', costo: 4200,  precio: 7000,  ubicacion: 1 },  // Anaquel A1
    { id_producto: productos[2 % productos.length].id_producto, numero_lote: 'LOTE-TEST-C01', fecha_venc: '2026-12-31', costo: 3100,  precio: 5500,  ubicacion: 5 },  // Anaquel M1
    { id_producto: productos[3 % productos.length].id_producto, numero_lote: 'LOTE-TEST-D01', fecha_venc: '2027-01-20', costo: 25000, precio: 40000, ubicacion: 4 },  // Caja Fuerte 1
  ];

  const loteIds = [];
  for (const l of lotes) {
    // Insertar lote si no existe
    await conn.query(
      `INSERT IGNORE INTO lotes (id_producto, numero_lote, fecha_vencimiento, estado, costo_unitario, precio_venta)
       VALUES (?, ?, ?, 'disponible', ?, ?)`,
      [l.id_producto, l.numero_lote, l.fecha_venc, l.costo, l.precio]
    );
    const [[loteRow]] = await conn.query('SELECT id_lote FROM lotes WHERE numero_lote = ?', [l.numero_lote]);
    loteIds.push({ id_lote: loteRow.id_lote, id_ubicacion: l.ubicacion });
  }

  // 4. Crear existencias con stock para cada lote
  const stocks = [50, 30, 120, 75, 40]; // cantidades iniciales
  for (let i = 0; i < loteIds.length; i++) {
    const { id_lote, id_ubicacion } = loteIds[i];

    // Obtener id_almacen de la ubicación
    const [[ubi]] = await conn.query(
      'SELECT id_almacen FROM ubicaciones_almacen WHERE id_ubicacion = ?', [id_ubicacion]
    );

    await conn.query(
      `INSERT INTO existencias (id_lote, id_almacen, id_ubicacion, cantidad_disponible, cantidad_reservada, cantidad_cuarentena)
       VALUES (?, ?, ?, ?, 0, 0)
       ON DUPLICATE KEY UPDATE cantidad_disponible = VALUES(cantidad_disponible)`,
      [id_lote, ubi.id_almacen, id_ubicacion, stocks[i]]
    );
  }

  // 5. Asegurar parametros de tipo_movimiento_entrada y tipo_movimiento_salida
  const paramEntrada = [
    { valor: 'entrada_compra',   etiqueta: 'Entrada compra',             orden: 1 },
    { valor: 'devolucion_venta', etiqueta: 'Devolución de venta',        orden: 2 },
    { valor: 'liberacion',       etiqueta: 'Liberación de cuarentena',   orden: 3 },
  ];
  const paramSalida = [
    { valor: 'salida_venta',     etiqueta: 'Salida por venta',           orden: 1 },
    { valor: 'merma',            etiqueta: 'Merma',                      orden: 2 },
    { valor: 'destruccion',      etiqueta: 'Destrucción',                orden: 3 },
    { valor: 'cuarentena',       etiqueta: 'Pasar a cuarentena',         orden: 4 },
    { valor: 'devolucion_compra',etiqueta: 'Devolución a proveedor',     orden: 5 },
  ];

  for (const p of paramEntrada) {
    await conn.query(
      `INSERT IGNORE INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo) VALUES (?,?,?,?,?,1)`,
      ['tipo_movimiento_entrada', 'Tipo Movimiento Entrada', p.valor, p.etiqueta, p.orden]
    );
  }
  for (const p of paramSalida) {
    await conn.query(
      `INSERT IGNORE INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo) VALUES (?,?,?,?,?,1)`,
      ['tipo_movimiento_salida', 'Tipo Movimiento Salida', p.valor, p.etiqueta, p.orden]
    );
  }

  await conn.commit();

  // 6. Verificación final
  console.log('\n=== ESTADO FINAL ===');
  const [stockFinal] = await conn.query(`
    SELECT p.nombre_comercial, p.sku, l.numero_lote, l.fecha_vencimiento,
           ROUND(e.cantidad_disponible,0) AS disponible, a.nombre AS almacen, u.nombre AS ubicacion
    FROM existencias e
    INNER JOIN lotes l ON l.id_lote = e.id_lote
    INNER JOIN productos p ON p.id_producto = l.id_producto
    INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
    INNER JOIN ubicaciones_almacen u ON u.id_ubicacion = e.id_ubicacion
    ORDER BY p.nombre_comercial, l.numero_lote
  `);
  console.log('\nStock disponible para movimientos:');
  stockFinal.forEach(r =>
    console.log(`  [${r.sku}] ${r.nombre_comercial} | Lote: ${r.numero_lote} | Stock: ${r.disponible} | ${r.almacen} > ${r.ubicacion}`)
  );

  const [pe] = await conn.query(`SELECT etiqueta FROM parametros_sistema WHERE grupo='tipo_movimiento_entrada' ORDER BY orden`);
  console.log('\nTipos entrada:', pe.map(r => r.etiqueta).join(', '));

  const [ps] = await conn.query(`SELECT etiqueta FROM parametros_sistema WHERE grupo='tipo_movimiento_salida' ORDER BY orden`);
  console.log('Tipos salida:', ps.map(r => r.etiqueta).join(', '));

} catch (err) {
  await conn.rollback();
  console.error('ERROR:', err.message);
  process.exit(1);
} finally {
  conn.release();
  await pool.end();
}
