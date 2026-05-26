import mysql from 'mysql2/promise';

// Pool de conexión a la BD HealthSphere (RDS AWS)
// Credenciales: admin / Neurum*2025
// Si la BD tiene nombre específico, configura HS_DB_NAME en .env
export const hsPool = mysql.createPool({
  host:     process.env.HS_DB_HOST     ?? 'pruebas-produccionhealthsphere.ce6agou8m1rx.us-east-1.rds.amazonaws.com',
  port:     Number(process.env.HS_DB_PORT ?? 3306),
  user:     process.env.HS_DB_USER     ?? 'admin',
  password: process.env.HS_DB_PASSWORD ?? 'Neurum*2025',
  database: process.env.HS_DB_NAME     ?? 'db_suhc_produccion',
  ssl:      { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit:    5,
  queueLimit:         0,
  connectTimeout:     15000,
  decimalNumbers:     true
});
