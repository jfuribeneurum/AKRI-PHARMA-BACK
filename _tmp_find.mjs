import { hsPool } from './src/config/hs-db.js';

const [rows] = await hsPool.query(
  `SELECT fm.* FROM suhc_new_tbl_formulacion_medicamentos fm
    WHERE fm.dx LIKE 'A000%' AND (fm.medicamento LIKE '%ACETAMINOFEN%' OR fm.medicamento LIKE '%SALBUTAMOL%')
    ORDER BY fm.Id DESC LIMIT 10`
);
console.log(JSON.stringify(rows, null, 2));

// distinct posologiaTipo / temporalidadTipo values to build the code->word map
const [tipos] = await hsPool.query(
  `SELECT DISTINCT posologiaTipo FROM suhc_new_tbl_formulacion_medicamentos LIMIT 20`
);
console.log('posologiaTipo values', tipos);
const [tipos2] = await hsPool.query(
  `SELECT DISTINCT temporalidadTipo FROM suhc_new_tbl_formulacion_medicamentos LIMIT 20`
);
console.log('temporalidadTipo values', tipos2);
process.exit(0);
