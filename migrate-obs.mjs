import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({
  host: 'pruebas-produccionhealthsphere.ce6agou8m1rx.us-east-1.rds.amazonaws.com',
  port: 3306, user: 'admin', password: 'Neurum*2025', database: 'akripharmacy',
  ssl: { rejectUnauthorized: false }
});
try {
  const [r] = await conn.execute("SHOW COLUMNS FROM proveedores LIKE 'observaciones'");
  if (r.length > 0) { console.log('observaciones ya existe'); }
  else {
    await conn.execute("ALTER TABLE proveedores ADD COLUMN observaciones TEXT NULL AFTER direccion");
    console.log('observaciones agregada OK');
  }
} catch(e) { console.error('ERROR:', e.message); }
finally { await conn.end(); }
