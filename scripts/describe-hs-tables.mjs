import 'dotenv/config';
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection({
  host:     process.env.HS_DB_HOST,
  port:     Number(process.env.HS_DB_PORT ?? 3306),
  user:     process.env.HS_DB_USER,
  password: process.env.HS_DB_PASSWORD,
  database: process.env.HS_DB_NAME,
  ssl:      { rejectUnauthorized: false },
});

const tables = ['suhc_new_tbl_formulacion', 'tblpaciente', 'suhc_new_tbl_formulacion_medicamentos'];

for (const t of tables) {
  try {
    const [rows] = await conn.query(`DESCRIBE \`${t}\``);
    console.log(`\n=== ${t} ===`);
    rows.forEach(r => console.log(`  ${r.Field.padEnd(35)} ${r.Type.padEnd(20)} ${r.Null} ${r.Key}`));

    const [sample] = await conn.query(`SELECT * FROM \`${t}\` LIMIT 2`);
    console.log(`  [sample]`, JSON.stringify(sample[0] ?? null));
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

await conn.end();
