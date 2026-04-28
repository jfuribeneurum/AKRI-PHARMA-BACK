import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const root = path.resolve(process.cwd(), '..');
const databaseDir = path.join(root, 'database');
const dbFiles = fs.readdirSync(databaseDir)
  .filter((file) => file.endsWith('.sql'))
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  .map((file) => path.join(databaseDir, file));

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? '3306'),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    multipleStatements: true
  });

  try {
    for (const file of dbFiles) {
      const sql = fs.readFileSync(file, 'utf8');
      console.log(`Ejecutando ${file}`);
      await connection.query(sql);
    }
    console.log('Base de datos inicializada correctamente.');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('Error inicializando la base de datos:', error);
  process.exit(1);
});
