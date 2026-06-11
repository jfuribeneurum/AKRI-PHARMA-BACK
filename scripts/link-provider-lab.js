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
});

async function run() {
  const conn = await pool.getConnection();
  try {
    // Listar todos los laboratorios
    const [labs] = await conn.execute(`SELECT id_laboratorio, nombre FROM laboratorios ORDER BY nombre`);
    console.log('\n=== LABORATORIOS DISPONIBLES ===');
    for (const lab of labs) {
      console.log(`  [${lab.id_laboratorio}] ${lab.nombre}`);
    }

    // Listar proveedores sin laboratorio vinculado
    const [provsSinLab] = await conn.execute(
      `SELECT id_proveedor, razon_social, id_laboratorio FROM proveedores ORDER BY razon_social`
    );
    console.log('\n=== PROVEEDORES Y SU LABORATORIO ACTUAL ===');
    for (const p of provsSinLab) {
      console.log(`  [${p.id_proveedor}] ${p.razon_social} → lab_id: ${p.id_laboratorio ?? 'NULL'}`);
    }

    // Vincular Bayer Colombia S.A. con Laboratorios Bayer S.A.S
    const bayer = labs.find(l => l.nombre.toLowerCase().includes('bayer'));
    const provBayer = provsSinLab.find(p => (p.razon_social ?? '').toLowerCase().includes('bayer'));

    if (!bayer) {
      console.log('\n⚠ No se encontró laboratorio con nombre que contenga "bayer". Revisa el nombre exacto arriba.');
      return;
    }
    if (!provBayer) {
      console.log('\n⚠ No se encontró proveedor con nombre que contenga "bayer". Revisa el nombre exacto arriba.');
      return;
    }

    console.log(`\n→ Vinculando proveedor [${provBayer.id_proveedor}] "${provBayer.razon_social}"`);
    console.log(`  con laboratorio [${bayer.id_laboratorio}] "${bayer.nombre}"`);

    await conn.execute(
      `UPDATE proveedores SET id_laboratorio = ? WHERE id_proveedor = ?`,
      [bayer.id_laboratorio, provBayer.id_proveedor]
    );
    console.log('✓ Vínculo guardado correctamente.');
    console.log('\nAhora en la OC, al seleccionar ese proveedor, aparecerán sus productos.');
  } finally {
    conn.release();
    await pool.end();
  }
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
