import { hsPool } from './src/config/hs-db.js';

const [p] = await hsPool.query(
  `SELECT posologiaTipo, COUNT(*) n FROM suhc_new_tbl_formulacion_medicamentos GROUP BY posologiaTipo`
);
console.log('posologiaTipo counts', p);

const [t] = await hsPool.query(
  `SELECT temporalidadTipo, COUNT(*) n FROM suhc_new_tbl_formulacion_medicamentos GROUP BY temporalidadTipo`
);
console.log('temporalidadTipo counts', t);

// sample rows for the rare tipo values, with posologia text-ish fields to see if any hints
for (const tt of [1,2,3]) {
  const [rows] = await hsPool.query(
    `SELECT Id, medicamento, posologia, posologiaTipo, posologiaTipoCantidad, temporalidad, temporalidadTipo, cantidad, observaciones
       FROM suhc_new_tbl_formulacion_medicamentos WHERE temporalidadTipo = ? LIMIT 5`, [tt]
  );
  console.log('temporalidadTipo='+tt, rows);
}
for (const pt of [1,2,3]) {
  const [rows] = await hsPool.query(
    `SELECT Id, medicamento, posologia, posologiaTipo, posologiaTipoCantidad, temporalidad, temporalidadTipo, cantidad, observaciones
       FROM suhc_new_tbl_formulacion_medicamentos WHERE posologiaTipo = ? LIMIT 5`, [pt]
  );
  console.log('posologiaTipo='+pt, rows);
}

// check maestrasdetalle for a possible catalog for these
const [cat] = await hsPool.query(
  `SELECT DISTINCT idMaestra FROM suhc_new_tbl_maestrasdetalle ORDER BY idMaestra`
);
console.log('idMaestra values', cat);
process.exit(0);
