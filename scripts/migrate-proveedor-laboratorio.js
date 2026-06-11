import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'akripharmacy',
  ssl: { rejectUnauthorized: false },
  multipleStatements: true
});

async function run() {
  const conn = await pool.getConnection();
  try {
    const [cols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'proveedores' AND COLUMN_NAME = 'id_laboratorio'`
    );
    if (cols.length > 0) {
      console.log('✓ La columna id_laboratorio ya existe en proveedores. Nada que hacer.');
      return;
    }

    await conn.execute(
      `ALTER TABLE proveedores ADD COLUMN id_laboratorio INT NULL`
    );
    console.log('✓ Columna id_laboratorio agregada a proveedores.');

    await conn.execute(
      `ALTER TABLE proveedores
       ADD CONSTRAINT fk_proveedores_laboratorio
         FOREIGN KEY (id_laboratorio) REFERENCES laboratorios(id_laboratorio)
         ON UPDATE CASCADE ON DELETE SET NULL`
    );
    console.log('✓ FK fk_proveedores_laboratorio creada.');
    console.log('\nMigración completada. Reinicia el backend.');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch(err => { console.error('Error en migración:', err.message); process.exit(1); });
