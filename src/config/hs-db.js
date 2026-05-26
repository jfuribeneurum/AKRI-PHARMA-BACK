import mysql from 'mysql2/promise';

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
