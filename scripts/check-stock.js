import mysql from 'mysql2/promise';
import 'dotenv/config';

const pool = await mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const conn = await pool.getConnection();

const [lotes] = await conn.query('SELECT id_lote, id_producto, numero_lote, fecha_vencimiento, estado FROM lotes LIMIT 10');
console.log('\nLOTES RAW:', JSON.stringify(lotes, null, 2));

const [prods] = await conn.query('SELECT id_producto, sku, nombre_comercial, activo FROM productos LIMIT 15');
console.log('\nPRODUCTOS:', JSON.stringify(prods, null, 2));

conn.release();
await pool.end();
