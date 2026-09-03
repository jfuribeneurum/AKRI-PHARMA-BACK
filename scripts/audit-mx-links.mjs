import mysql from 'mysql2/promise';
import 'dotenv/config';

// Audita, para cada producto con stock real > 0, si el modal de dispensación
// (getFormulacionHSById en formulacion-hs.service.js) podrá resolverlo cuando
// aparezca en una formulación de HealthSphere — por id_medicamento_hs válido
// o por coincidencia de texto (nombre_comercial / principio_activo) contra el
// historial real de formulaciones. Sin esto, un producto puede tener stock
// real y aun así mostrar "Sin MX" en el modal de dispensación.
//
// Uso: node scripts/audit-mx-links.mjs

function normalizeMedText(s) {
  return (s ?? '').toString().trim().toUpperCase().replace(/\s+/g, ' ');
}
function stripSpaces(s) {
  return normalizeMedText(s).replace(/\s+/g, '');
}

const akri = await mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const hs = await mysql.createPool({
  host: process.env.HS_DB_HOST,
  port: Number(process.env.HS_DB_PORT) || 3306,
  user: process.env.HS_DB_USER,
  password: process.env.HS_DB_PASSWORD,
  database: process.env.HS_DB_NAME
});

const [productos] = await akri.query(
  `SELECT p.id_producto, p.sku, p.nombre_comercial, p.principio_activo, p.id_medicamento_hs,
          SUM(e.cantidad_disponible) AS stock_total
     FROM productos p
     INNER JOIN lotes l ON l.id_producto = p.id_producto
     INNER JOIN existencias e ON e.id_lote = l.id_lote
    WHERE p.activo = TRUE
    GROUP BY p.id_producto
   HAVING stock_total > 0
    ORDER BY p.id_producto`
);

const [masterRows] = await hs.query(`SELECT id FROM suhc_new_tbl_medicine`);
const masterIdsSet = new Set(masterRows.map((r) => r.id));

const [textosHs] = await hs.query(
  `SELECT DISTINCT medicamento FROM suhc_new_tbl_formulacion_medicamentos
    WHERE medicamento IS NOT NULL AND medicamento <> ''`
);
const textosHsNorm = new Set(textosHs.map((r) => normalizeMedText(r.medicamento)));
const textosHsStripped = new Set(textosHs.map((r) => stripSpaces(r.medicamento)));

const groups = { linkedValid: [], linkedBroken: [], textOk: [], strippedOk: [], noMatch: [] };

for (const p of productos) {
  if (p.id_medicamento_hs) {
    (masterIdsSet.has(p.id_medicamento_hs) ? groups.linkedValid : groups.linkedBroken).push(p);
    continue;
  }
  const nombreNorm = normalizeMedText(p.nombre_comercial);
  const paNorm = normalizeMedText(p.principio_activo);
  if (textosHsNorm.has(nombreNorm) || textosHsNorm.has(paNorm)) {
    groups.textOk.push(p);
    continue;
  }
  const nombreStripped = stripSpaces(p.nombre_comercial);
  const paStripped = stripSpaces(p.principio_activo);
  if (textosHsStripped.has(nombreStripped) || textosHsStripped.has(paStripped)) {
    groups.strippedOk.push(p);
    continue;
  }
  groups.noMatch.push(p);
}

console.log(`Total productos con stock real: ${productos.length}`);
console.log(`  Vinculados con id_medicamento_hs válido: ${groups.linkedValid.length}`);
console.log(`  id_medicamento_hs ROTO (no existe en catálogo maestro HS): ${groups.linkedBroken.length}`);
console.log(`  Sin id, resuelven por texto exacto: ${groups.textOk.length}`);
console.log(`  Sin id, resuelven por texto sin espacios: ${groups.strippedOk.length}`);
console.log(`  SIN NINGÚN MATCH POSIBLE (riesgo real de "Sin MX"): ${groups.noMatch.length}`);

if (groups.linkedBroken.length) {
  console.log('\n=== id_medicamento_hs ROTO (requiere corrección de datos) ===');
  console.table(groups.linkedBroken.map((p) => ({
    id: p.id_producto, sku: p.sku, nombre: p.nombre_comercial, id_hs: p.id_medicamento_hs, stock: p.stock_total
  })));
}

if (groups.noMatch.length) {
  console.log('\n=== SIN NINGÚN MATCH (ni id, ni texto — revisar manualmente) ===');
  console.table(groups.noMatch.map((p) => ({
    id: p.id_producto, sku: p.sku, nombre: p.nombre_comercial, principio_activo: p.principio_activo, stock: p.stock_total
  })));
}

await akri.end();
await hs.end();

process.exit(groups.linkedBroken.length || groups.noMatch.length ? 1 : 0);
