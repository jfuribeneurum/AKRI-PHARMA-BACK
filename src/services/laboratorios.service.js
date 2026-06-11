import { query } from '../config/db.js';

export async function listLaboratorios() {
  return query(
    `SELECT id_laboratorio, codigo, tipo_identificacion, numero_identificacion, digito_verificacion,
            nombre, nombres, apellidos, telefono, email, pais, ciudad, departamento, direccion, activo
       FROM laboratorios
      ORDER BY nombre ASC`
  );
}

export async function createLaboratorio(data) {
  const nombre = (data.nombre ?? '').trim();
  const result = await query(
    `INSERT INTO laboratorios (
       codigo, tipo_identificacion, numero_identificacion, digito_verificacion,
       nombre, nombres, apellidos, telefono, email, pais, ciudad, departamento, direccion, activo
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.codigo?.trim() || null,
      data.tipo_identificacion ?? 'NIT',
      data.numero_identificacion?.trim() || null,
      data.digito_verificacion?.trim() || null,
      nombre,
      data.nombres?.trim() || null,
      data.apellidos?.trim() || null,
      data.telefono?.trim() || null,
      data.email?.trim() || null,
      data.pais?.trim() || null,
      data.ciudad?.trim() || null,
      data.departamento?.trim() || null,
      data.direccion?.trim() || null,
      data.activo !== false,
    ]
  );
  return { id_laboratorio: result.insertId };
}

export async function updateLaboratorio(id, data) {
  const nombre = (data.nombre ?? '').trim();
  await query(
    `UPDATE laboratorios SET
       codigo = ?,
       tipo_identificacion = ?,
       numero_identificacion = ?,
       digito_verificacion = ?,
       nombre = ?,
       nombres = ?,
       apellidos = ?,
       telefono = ?,
       email = ?,
       pais = ?,
       ciudad = ?,
       departamento = ?,
       direccion = ?,
       activo = ?
     WHERE id_laboratorio = ?`,
    [
      data.codigo?.trim() || null,
      data.tipo_identificacion ?? 'NIT',
      data.numero_identificacion?.trim() || null,
      data.digito_verificacion?.trim() || null,
      nombre,
      data.nombres?.trim() || null,
      data.apellidos?.trim() || null,
      data.telefono?.trim() || null,
      data.email?.trim() || null,
      data.pais?.trim() || null,
      data.ciudad?.trim() || null,
      data.departamento?.trim() || null,
      data.direccion?.trim() || null,
      data.activo !== false,
      id,
    ]
  );
}
