import { hsPool } from './src/config/hs-db.js';

for (const im of [2,3,4,7,8,9,10,11,12,13,14,15,16,17,18]) {
  const [rows] = await hsPool.query(
    `SELECT id, codigo, descripcion FROM suhc_new_tbl_maestrasdetalle WHERE idMaestra = ? ORDER BY id LIMIT 10`, [im]
  );
  console.log('idMaestra='+im, rows);
}
process.exit(0);
