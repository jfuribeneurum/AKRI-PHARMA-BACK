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
  // 1. Ver todos los registros en traslados
  const [traslados] = await conn.query(`SELECT * FROM traslados ORDER BY id_traslado DESC LIMIT 10`);
  console.log(`\n=== TRASLADOS EN DB (${traslados.length}) ===`);
  traslados.forEach(t => console.log(JSON.stringify(t)));

  if (traslados.length === 0) {
    console.log('No hay traslados — el POST no insertó nada.');
  } else {
    const t = traslados[0];
    console.log('\n=== VERIFICANDO FOREIGN KEYS DEL TRASLADO #' + t.id_traslado + ' ===');

    const [[prod]] = await conn.query(`SELECT id_producto, nombre_comercial FROM productos WHERE id_producto = ?`, [t.id_producto]);
    console.log('Producto:', prod ?? 'NO EXISTE');

    const [[lote]] = await conn.query(`SELECT id_lote, numero_lote FROM lotes WHERE id_lote = ?`, [t.id_lote]);
    console.log('Lote:', lote ?? 'NO EXISTE');

    const [[ao]] = await conn.query(`SELECT id_almacen, nombre FROM almacenes WHERE id_almacen = ?`, [t.id_almacen_origen]);
    console.log('Almacen origen:', ao ?? 'NO EXISTE');

    const [[uo]] = await conn.query(`SELECT id_ubicacion, nombre FROM ubicaciones_almacen WHERE id_ubicacion = ?`, [t.id_ubicacion_origen]);
    console.log('Ubicacion origen:', uo ?? 'NO EXISTE');

    const [[ad]] = await conn.query(`SELECT id_almacen, nombre FROM almacenes WHERE id_almacen = ?`, [t.id_almacen_destino]);
    console.log('Almacen destino:', ad ?? 'NO EXISTE');

    const [[ud]] = await conn.query(`SELECT id_ubicacion, nombre FROM ubicaciones_almacen WHERE id_ubicacion = ?`, [t.id_ubicacion_destino]);
    console.log('Ubicacion destino:', ud ?? 'NO EXISTE');

    // 2. Ejecutar la query completa de listTraslados
    console.log('\n=== QUERY COMPLETA listTraslados ===');
    const [rows] = await conn.query(`
      SELECT t.id_traslado, t.estado
      FROM traslados t
      INNER JOIN productos p ON p.id_producto = t.id_producto
      INNER JOIN lotes l ON l.id_lote = t.id_lote
      INNER JOIN almacenes ao ON ao.id_almacen = t.id_almacen_origen
      INNER JOIN ubicaciones_almacen uo ON uo.id_ubicacion = t.id_ubicacion_origen
      INNER JOIN almacenes ad ON ad.id_almacen = t.id_almacen_destino
      INNER JOIN ubicaciones_almacen ud ON ud.id_ubicacion = t.id_ubicacion_destino
      WHERE t.estado = 'pendiente'
      ORDER BY t.fecha_envio DESC
    `);
    console.log(`Resultados: ${rows.length}`);
    rows.forEach(r => console.log(JSON.stringify(r)));
  }
} finally {
  conn.release();
  await pool.end();
}
