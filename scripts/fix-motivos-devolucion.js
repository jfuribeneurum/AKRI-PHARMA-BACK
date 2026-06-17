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
try {
  const toDelete = [
    'Producto vencido',
    'Producto dañado / deteriorado',
    'Error en pedido',
    'Exceso de inventario',
  ];
  for (const val of toDelete) {
    const [r] = await conn.query(
      `DELETE FROM parametros_sistema WHERE grupo = 'motivo_devolucion' AND valor = ?`,
      [val]
    );
    if (r.affectedRows > 0) console.log(`Eliminado: "${val}"`);
  }

  const toInsert = [
    { valor: 'Producto no requerido',          etiqueta: 'Producto no requerido',          orden: 1 },
    { valor: 'Producto averiado',              etiqueta: 'Producto averiado',              orden: 2 },
    { valor: 'Cantidad mayor a la solicitada', etiqueta: 'Cantidad mayor a la solicitada', orden: 3 },
    { valor: 'Otro',                           etiqueta: 'Otro',                           orden: 4 },
  ];
  for (const row of toInsert) {
    const [r] = await conn.query(
      `INSERT IGNORE INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo)
       VALUES ('motivo_devolucion', 'Motivo de Devolución', ?, ?, ?, 1)`,
      [row.valor, row.etiqueta, row.orden]
    );
    if (r.affectedRows > 0) console.log(`Insertado: "${row.etiqueta}"`);
    else {
      await conn.query(
        `UPDATE parametros_sistema SET orden = ?, activo = 1 WHERE grupo = 'motivo_devolucion' AND valor = ?`,
        [row.orden, row.valor]
      );
      console.log(`Actualizado orden: "${row.etiqueta}"`);
    }
  }

  const [rows] = await conn.query(
    `SELECT valor, etiqueta, orden FROM parametros_sistema WHERE grupo = 'motivo_devolucion' ORDER BY orden`
  );
  console.log('\nMotivos finales:');
  rows.forEach(r => console.log(`  ${r.orden}. ${r.etiqueta}`));
} finally {
  conn.release();
  await pool.end();
}
