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
  await conn.query(`
    CREATE TABLE IF NOT EXISTS traslados (
      id_traslado           INT UNSIGNED NOT NULL AUTO_INCREMENT,
      id_producto           INT NOT NULL,
      id_lote               INT NOT NULL,
      id_almacen_origen     INT NOT NULL,
      id_ubicacion_origen   INT NOT NULL,
      id_almacen_destino    INT NOT NULL,
      id_ubicacion_destino  INT NOT NULL,
      cantidad              DECIMAL(14,4) NOT NULL,
      motivo                VARCHAR(500) NULL,
      estado                ENUM('pendiente','recibido','rechazado') NOT NULL DEFAULT 'pendiente',
      observaciones_recepcion TEXT NULL,
      fecha_envio           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fecha_recepcion       DATETIME NULL,
      id_usuario_origen     INT NULL,
      id_usuario_destino    INT NULL,
      id_movimiento         INT NULL,
      PRIMARY KEY (id_traslado),
      INDEX idx_trl_estado (estado),
      INDEX idx_trl_almacen_origen (id_almacen_origen),
      INDEX idx_trl_almacen_destino (id_almacen_destino),
      INDEX idx_trl_lote (id_lote)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('Tabla traslados creada correctamente.');

  const [[{ count }]] = await conn.query('SELECT COUNT(*) AS count FROM traslados');
  console.log(`Registros actuales en traslados: ${count}`);
} finally {
  conn.release();
  await pool.end();
}
