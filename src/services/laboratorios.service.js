import { query } from '../config/db.js';

export async function listLaboratorios() {
  return query(
    `SELECT id_laboratorio, nombre, activo
       FROM laboratorios
      ORDER BY nombre ASC`
  );
}

export async function createLaboratorio(data) {
  const nombre = (data.nombre ?? '').trim();
  const result = await query(
    `INSERT INTO laboratorios (nombre, activo) VALUES (?, ?)`,
    [nombre, data.activo !== false]
  );
  return { id_laboratorio: result.insertId };
}

export async function updateLaboratorio(id, data) {
  const nombre = (data.nombre ?? '').trim();
  await query(
    `UPDATE laboratorios SET nombre = ?, activo = ? WHERE id_laboratorio = ?`,
    [nombre, data.activo !== false, id]
  );
}
