import mysql from 'mysql2/promise';
import { logger } from '../utils/logger.js';

// Credenciales leídas desde .env — nunca hardcodeadas aquí
export const hsPool = mysql.createPool({
  host:     process.env.HS_DB_HOST,
  port:     Number(process.env.HS_DB_PORT ?? 3306),
  user:     process.env.HS_DB_USER,
  password: process.env.HS_DB_PASSWORD,
  database: process.env.HS_DB_NAME,
  ssl:      { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit:    5,
  queueLimit:         0,
  connectTimeout:     15000,
  decimalNumbers:     true
});

// HealthSphere es una base externa fuera de nuestro control — los cortes de
// red hacia ella son más frecuentes que hacia la propia. Sin este listener,
// ese 'error' del pool tumba el proceso completo en vez de solo fallar la
// petición en curso (visto en vivo: el backend se cayó durante un corte de
// red real mientras se validaba este mismo punto).
hsPool.on('error', (error) => {
  logger.error({ err: error.message, code: error.code }, 'Error en el pool de MySQL (HealthSphere)');
});
