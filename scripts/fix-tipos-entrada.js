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
  const [del] = await conn.query(
    `DELETE FROM parametros_sistema WHERE grupo = 'tipo_movimiento_entrada'`
  );
  console.log(`Tipos de entrada eliminados: ${del.affectedRows}`);

  const nuevos = [
    { valor: 'inventario_sobrante_fisico', etiqueta: 'Inventario sobrante físico', orden: 1 },
    { valor: 'bonificacion',               etiqueta: 'Bonificación',               orden: 2 },
  ];
  for (const p of nuevos) {
    await conn.query(
      `INSERT INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo)
       VALUES ('tipo_movimiento_entrada', 'Tipo Movimiento Entrada', ?, ?, ?, 1)`,
      [p.valor, p.etiqueta, p.orden]
    );
  }

  const [rows] = await conn.query(
    `SELECT orden, etiqueta, valor FROM parametros_sistema WHERE grupo = 'tipo_movimiento_entrada' ORDER BY orden`
  );
  console.log('\nTipos de movimiento entrada actuales:');
  rows.forEach(r => console.log(`  ${r.orden}. ${r.etiqueta} (${r.valor})`));
} finally {
  conn.release();
  await pool.end();
}
