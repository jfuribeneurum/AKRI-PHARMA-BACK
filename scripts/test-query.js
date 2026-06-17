import mysql from 'mysql2/promise';
import 'dotenv/config';
const pool = await mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT)||3306, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
try {
  const [rows] = await pool.query(`
    SELECT
      t.id_traslado,
      t.estado,
      t.cantidad,
      t.motivo,
      t.observaciones_recepcion,
      t.fecha_envio,
      t.fecha_recepcion,
      t.id_movimiento,
      p.nombre_comercial,
      p.sku,
      l.numero_lote,
      l.fecha_vencimiento,
      ao.nombre AS almacen_origen,
      uo.nombre AS ubicacion_origen,
      ad.nombre AS almacen_destino,
      ud.nombre AS ubicacion_destino,
      uo_orig.id_usuario_origen,
      uo_dest.id_usuario_destino,
      u_orig.nombre_completo AS nombre_emisor,
      u_dest.nombre_completo AS nombre_receptor
    FROM traslados t
    INNER JOIN productos p ON p.id_producto = t.id_producto
    INNER JOIN lotes l ON l.id_lote = t.id_lote
    INNER JOIN almacenes ao ON ao.id_almacen = t.id_almacen_origen
    INNER JOIN ubicaciones_almacen uo ON uo.id_ubicacion = t.id_ubicacion_origen
    INNER JOIN almacenes ad ON ad.id_almacen = t.id_almacen_destino
    INNER JOIN ubicaciones_almacen ud ON ud.id_ubicacion = t.id_ubicacion_destino
    LEFT JOIN (SELECT id_traslado, id_usuario_origen FROM traslados) uo_orig ON uo_orig.id_traslado = t.id_traslado
    LEFT JOIN (SELECT id_traslado, id_usuario_destino FROM traslados) uo_dest ON uo_dest.id_traslado = t.id_traslado
    LEFT JOIN usuarios u_orig ON u_orig.id_usuario = t.id_usuario_origen
    LEFT JOIN usuarios u_dest ON u_dest.id_usuario = t.id_usuario_destino
    WHERE t.estado = 'pendiente'
    ORDER BY t.fecha_envio DESC LIMIT 200
  `);
  console.log('Rows:', rows.length);
  rows.forEach(r => console.log(JSON.stringify(r)));
} catch(e) {
  console.error('ERROR:', e.message);
}
await pool.end();
