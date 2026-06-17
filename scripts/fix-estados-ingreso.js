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
  // 1. Migrar ingresos existentes con estado obsoleto → recibido
  const [upd] = await conn.query(
    `UPDATE ingresos SET estado = 'recibido' WHERE estado IN ('pendiente', 'almacenado')`
  );
  console.log(`Ingresos actualizados a 'recibido': ${upd.affectedRows}`);

  // 2. Eliminar estados obsoletos de parametros_sistema
  const [del] = await conn.query(
    `DELETE FROM parametros_sistema WHERE grupo = 'estado_ingreso' AND valor IN ('pendiente', 'almacenado')`
  );
  console.log(`Parámetros eliminados (pendiente/almacenado): ${del.affectedRows}`);

  // 3. Asegurar que recibido y cancelado existen con orden correcto
  await conn.query(
    `INSERT IGNORE INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo)
     VALUES ('estado_ingreso', 'Estado de Ingreso', 'recibido', 'Recibido', 1, 1)`
  );
  await conn.query(
    `UPDATE parametros_sistema SET orden = 1, activo = 1 WHERE grupo = 'estado_ingreso' AND valor = 'recibido'`
  );
  await conn.query(
    `INSERT IGNORE INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo)
     VALUES ('estado_ingreso', 'Estado de Ingreso', 'cancelado', 'Cancelado', 2, 1)`
  );
  await conn.query(
    `UPDATE parametros_sistema SET orden = 2, activo = 1 WHERE grupo = 'estado_ingreso' AND valor = 'cancelado'`
  );

  // 4. Verificar estado final
  const [rows] = await conn.query(
    `SELECT valor, etiqueta, orden FROM parametros_sistema WHERE grupo = 'estado_ingreso' ORDER BY orden`
  );
  console.log('\nEstados finales en parametros_sistema:');
  rows.forEach(r => console.log(`  ${r.orden}. ${r.etiqueta} (${r.valor})`));

  const [[counts]] = await conn.query(
    `SELECT
       SUM(estado = 'recibido')  AS recibido,
       SUM(estado = 'cancelado') AS cancelado,
       SUM(estado NOT IN ('recibido','cancelado')) AS otros
     FROM ingresos`
  );
  console.log(`\nIngresos en DB: recibido=${counts.recibido}, cancelado=${counts.cancelado}, otros=${counts.otros}`);
} finally {
  conn.release();
  await pool.end();
}
