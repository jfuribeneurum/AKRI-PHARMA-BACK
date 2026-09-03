import mysql from 'mysql2/promise';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: true,
  namedPlaceholders: true,
  multipleStatements: true
});

// Sin este listener, un corte de red hacia la base (algo transitorio y
// normal contra RDS) emite un 'error' en el pool que Node no atrapa en
// ningún otro lado — tumba el proceso completo en vez de solo la
// petición en curso. Loguear y dejar vivo el proceso; mysql2 reconecta
// solo en la siguiente consulta.
pool.on('error', (error) => {
  logger.error({ err: error.message, code: error.code }, 'Error en el pool de MySQL (akripharmacy)');
});

export async function query(sql, params = {}) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function withTransaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
