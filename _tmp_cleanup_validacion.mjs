import 'dotenv/config';
import mysql from 'mysql2/promise';
const pool = mysql.createPool({
  host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

// 1) Revertir el +7 sobre el lote real FIBRILOK 594 (volver a 1710)
await pool.query(`UPDATE existencias SET cantidad_disponible = cantidad_disponible - 7 WHERE id_lote = 594 AND id_almacen = 6 AND id_ubicacion = 7`);
const [check1] = await pool.query(`SELECT cantidad_disponible FROM existencias WHERE id_lote = 594 AND id_almacen = 6 AND id_ubicacion = 7`);
console.log('FIBRILOK 594 revertido, cantidad_disponible ahora:', check1[0].cantidad_disponible, '(esperado 1710)');

// 2) Borrar el lote de prueba 875 (TEST-VALIDACION-001) y su existencia
await pool.query(`DELETE FROM existencias WHERE id_lote = 875`);
await pool.query(`DELETE FROM lotes WHERE id_lote = 875`);

// 3) Borrar los 3 movimientos de prueba
const [del] = await pool.query(`DELETE FROM movimientos_inventario WHERE id_movimiento IN (4481, 4482, 4483)`);
console.log('movimientos de prueba borrados:', del.affectedRows);

await pool.end();
