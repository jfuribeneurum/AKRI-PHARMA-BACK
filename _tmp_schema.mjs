import { hsPool } from './src/config/hs-db.js';

const [cols] = await hsPool.query(
  `SHOW COLUMNS FROM suhc_new_tbl_formulacion_medicamentos`
);
console.log(cols.map(c => c.Field));

const [rows] = await hsPool.query(
  `SELECT * FROM suhc_new_tbl_formulacion_medicamentos WHERE medicamento LIKE '%ACETAMINOFEN%HIDROCODONA%5 MG%' ORDER BY Id DESC LIMIT 3`
);
console.log(JSON.stringify(rows, null, 2));
process.exit(0);
