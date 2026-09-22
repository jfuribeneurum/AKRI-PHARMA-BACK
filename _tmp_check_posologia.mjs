import { hsPool } from './src/config/hs-db.js';

const [rows] = await hsPool.query(
  `SELECT fm.Id, fm.medicamento, fm.posologia, fm.temporalidad, fm.temporalidadTipo, fm.unidadDosificacion, fm.cantidad
     FROM suhc_new_tbl_formulacion_medicamentos fm
    WHERE fm.medicamento LIKE '%ACETAMINOFEN%HIDROCODONA%' OR fm.medicamento LIKE '%SALBUTAMOL%'
    ORDER BY fm.Id DESC LIMIT 15`
);
console.log(rows);

const [sample] = await hsPool.query(
  `SELECT fm.Id, fm.posologia, fm.temporalidad, fm.temporalidadTipo
     FROM suhc_new_tbl_formulacion_medicamentos fm
    WHERE fm.posologia IS NOT NULL AND fm.posologia <> ''
    ORDER BY fm.Id DESC LIMIT 20`
);
console.log(sample);
process.exit(0);
