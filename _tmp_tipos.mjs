import { hsPool } from './src/config/hs-db.js';

const [t1] = await hsPool.query(
  `SELECT posologiaTipo, posologiaTipoCantidad, COUNT(*) n
     FROM suhc_new_tbl_formulacion_medicamentos
    GROUP BY posologiaTipo, posologiaTipoCantidad
    ORDER BY posologiaTipo, n DESC LIMIT 40`
);
console.log('posologiaTipo x cantidad', t1);

const [t2] = await hsPool.query(
  `SELECT temporalidadTipo, temporalidad, COUNT(*) n
     FROM suhc_new_tbl_formulacion_medicamentos
    GROUP BY temporalidadTipo, temporalidad
    ORDER BY temporalidadTipo, n DESC LIMIT 60`
);
console.log('temporalidadTipo x temporalidad', t2);
process.exit(0);
