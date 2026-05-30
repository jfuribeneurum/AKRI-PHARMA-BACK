import { query } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';

export async function listCiudades({ search = '', departamento = '', soloActivas = false, page = 1, limit = 50 } = {}) {
  const offset = (Math.max(1, page) - 1) * limit;
  const conditions = [];
  const params = [];

  if (search.trim()) {
    conditions.push(`(nombre LIKE ? OR departamento LIKE ? OR codigo_dane LIKE ?)`);
    const w = `%${search.trim()}%`;
    params.push(w, w, w);
  }
  if (departamento.trim()) {
    conditions.push(`departamento = ?`);
    params.push(departamento.trim());
  }
  if (soloActivas) {
    conditions.push(`activo = 1`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [{ total }] = await query(
    `SELECT COUNT(*) AS total FROM ciudades ${where}`,
    params
  );

  const data = await query(
    `SELECT id, nombre, departamento, codigo_dane, activo
       FROM ciudades ${where}
      ORDER BY departamento ASC, nombre ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { data, total: Number(total), page, limit };
}

export async function listDepartamentos() {
  return query(
    `SELECT DISTINCT departamento FROM ciudades WHERE activo = 1 ORDER BY departamento ASC`
  );
}

export async function getCiudadById(id) {
  const [row] = await query(`SELECT * FROM ciudades WHERE id = ?`, [id]);
  return row ?? null;
}

export async function createCiudad(data) {
  const nombre       = (data.nombre ?? '').trim();
  const departamento = (data.departamento ?? '').trim();
  const codigoDane   = (data.codigo_dane ?? '').trim() || null;

  if (!nombre)       throw new HttpError(400, 'El nombre es requerido');
  if (!departamento) throw new HttpError(400, 'El departamento es requerido');

  const result = await query(
    `INSERT INTO ciudades (nombre, departamento, codigo_dane, activo) VALUES (?, ?, ?, ?)`,
    [nombre, departamento, codigoDane, data.activo !== false ? 1 : 0]
  );
  return { id: result.insertId };
}

export async function updateCiudad(id, data) {
  const ciudad = await getCiudadById(id);
  if (!ciudad) throw new HttpError(404, 'Ciudad no encontrada');

  const nombre       = (data.nombre ?? ciudad.nombre).trim();
  const departamento = (data.departamento ?? ciudad.departamento).trim();
  const codigoDane   = data.codigo_dane !== undefined
    ? ((data.codigo_dane ?? '').trim() || null)
    : ciudad.codigo_dane;

  if (!nombre)       throw new HttpError(400, 'El nombre es requerido');
  if (!departamento) throw new HttpError(400, 'El departamento es requerido');

  await query(
    `UPDATE ciudades SET nombre = ?, departamento = ?, codigo_dane = ?, activo = ? WHERE id = ?`,
    [nombre, departamento, codigoDane, data.activo !== undefined ? (data.activo ? 1 : 0) : ciudad.activo, id]
  );
}

export async function toggleCiudad(id) {
  const ciudad = await getCiudadById(id);
  if (!ciudad) throw new HttpError(404, 'Ciudad no encontrada');
  await query(`UPDATE ciudades SET activo = ? WHERE id = ?`, [ciudad.activo ? 0 : 1, id]);
  return { activo: !ciudad.activo };
}
