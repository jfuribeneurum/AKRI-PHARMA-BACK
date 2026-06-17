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
  // Eliminar tipos de salida anteriores
  const [del] = await conn.query(
    `DELETE FROM parametros_sistema WHERE grupo = 'tipo_movimiento_salida'`
  );
  console.log(`Tipos de salida eliminados: ${del.affectedRows}`);

  // Insertar los 3 nuevos
  const nuevos = [
    { valor: 'inventario_faltante_fisico', etiqueta: 'Inventario faltante físico', orden: 1 },
    { valor: 'disposicion_final',          etiqueta: 'Disposición final',          orden: 2 },
    { valor: 'movimiento_interno',         etiqueta: 'Movimiento interno',         orden: 3 },
  ];
  for (const p of nuevos) {
    await conn.query(
      `INSERT INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo)
       VALUES ('tipo_movimiento_salida', 'Tipo Movimiento Salida', ?, ?, ?, 1)`,
      [p.valor, p.etiqueta, p.orden]
    );
  }

  const [rows] = await conn.query(
    `SELECT orden, etiqueta, valor FROM parametros_sistema WHERE grupo = 'tipo_movimiento_salida' ORDER BY orden`
  );
  console.log('\nTipos de movimiento salida actuales:');
  rows.forEach(r => console.log(`  ${r.orden}. ${r.etiqueta} (${r.valor})`));
} finally {
  conn.release();
  await pool.end();
}
