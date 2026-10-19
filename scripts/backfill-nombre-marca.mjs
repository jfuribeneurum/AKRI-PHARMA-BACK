// Completa productos.nombre_marca ("Nombre comercial" en Maestro MX) con la
// marca que trae HealthSphere (suhc_new_tbl_medicine.nombreComercial).
// Idempotente: solo toca productos con nombre_marca vacío.
//
//   node scripts/backfill-nombre-marca.mjs --dry-run   # solo reporta
//   node scripts/backfill-nombre-marca.mjs             # aplica
import 'dotenv/config';
import { pool } from '../src/config/db.js';
import { hsPool } from '../src/config/hs-db.js';
import { ensureRuntimeSchema } from '../src/services/runtime-schema.service.js';
import { backfillNombreMarcaFromHs } from '../src/services/product.service.js';

const dryRun = process.argv.includes('--dry-run');

try {
  // Garantiza que la columna exista aunque el backend aún no haya arrancado
  // con esta versión.
  await ensureRuntimeSchema();
  const res = await backfillNombreMarcaFromHs(null, { dryRun });
  console.log(`${dryRun ? '[dry-run] ' : ''}Candidatos: ${res.candidatos} · ${dryRun ? 'Se actualizarían' : 'Actualizados'}: ${res.actualizados}`);
  console.table(res.muestra);
} finally {
  await pool.end();
  await hsPool.end();
}
