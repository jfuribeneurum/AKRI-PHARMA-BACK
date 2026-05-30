import { query } from '../config/db.js';

export async function listProviders() {
  return query(
    `SELECT id_proveedor, codigo, tipo_identificacion, numero_identificacion, digito_verificacion,
            razon_social, nombres, apellidos, telefono, email, ciudad, departamento, direccion, activo
       FROM proveedores
      ORDER BY COALESCE(razon_social, nombre) ASC`
  );
}

export async function createProvider(data) {
  const razonSocial = (data.razon_social ?? '').trim();
  const result = await query(
    `INSERT INTO proveedores (
       codigo, tipo_identificacion, numero_identificacion, digito_verificacion,
       razon_social, nombre, nombres, apellidos, telefono, email, ciudad, departamento, direccion, activo
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.codigo?.trim() || null,
      data.tipo_identificacion ?? 'NIT',
      (data.numero_identificacion ?? '').trim(),
      data.digito_verificacion?.trim() || null,
      razonSocial,
      razonSocial,
      data.nombres?.trim() || null,
      data.apellidos?.trim() || null,
      data.telefono?.trim() || null,
      data.email?.trim() || null,
      data.ciudad?.trim() || null,
      data.departamento?.trim() || null,
      data.direccion?.trim() || null,
      data.activo !== false
    ]
  );
  return { id_proveedor: result.insertId };
}

export async function updateProvider(id, data) {
  const razonSocial = (data.razon_social ?? '').trim();
  await query(
    `UPDATE proveedores SET
       codigo = ?,
       tipo_identificacion = ?,
       numero_identificacion = ?,
       digito_verificacion = ?,
       razon_social = ?,
       nombre = ?,
       nombres = ?,
       apellidos = ?,
       telefono = ?,
       email = ?,
       ciudad = ?,
       departamento = ?,
       direccion = ?,
       activo = ?
     WHERE id_proveedor = ?`,
    [
      data.codigo?.trim() || null,
      data.tipo_identificacion ?? 'NIT',
      (data.numero_identificacion ?? '').trim(),
      data.digito_verificacion?.trim() || null,
      razonSocial,
      razonSocial,
      data.nombres?.trim() || null,
      data.apellidos?.trim() || null,
      data.telefono?.trim() || null,
      data.email?.trim() || null,
      data.ciudad?.trim() || null,
      data.departamento?.trim() || null,
      data.direccion?.trim() || null,
      data.activo !== false,
      id
    ]
  );
}
