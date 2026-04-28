import { ensureRuntimeSchema } from '../src/services/runtime-schema.service.js';
import { pool } from '../src/config/db.js';

async function main() {
  try {
    await ensureRuntimeSchema({ force: true });
    console.log('Esquema runtime verificado y reparado correctamente.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('No fue posible reparar el esquema runtime:', error.message);
  process.exit(1);
});
