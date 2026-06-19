import { query } from '../config/db.js';

export async function listProviders() {
  return query(
    `SELECT p.id_proveedor, p.tipo_identificacion, p.numero_identificacion, p.digito_verificacion,
            p.razon_social, p.nombres, p.apellidos, p.telefono, p.email, p.ciudad, p.departamento,
            p.pais, p.direccion, p.observaciones, p.regimen, p.activo
       FROM proveedores p
      ORDER BY COALESCE(p.razon_social, p.nombre) ASC`
  );
}

export async function createProvider(data) {
  const razonSocial = (data.razon_social ?? '').trim();
  const result = await query(
    `INSERT INTO proveedores (
       tipo_identificacion, numero_identificacion, digito_verificacion,
       razon_social, nombre, nombres, apellidos, telefono, email, ciudad, departamento, pais, direccion, observaciones, regimen, activo
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
      data.pais?.trim() || null,
      data.direccion?.trim() || null,
      data.observaciones?.trim() || null,
      data.regimen?.trim() || null,
      data.activo !== false
    ]
  );
  return { id_proveedor: result.insertId };
}

export async function updateProvider(id, data) {
  const razonSocial = (data.razon_social ?? '').trim();
  await query(
    `UPDATE proveedores SET
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
       pais = ?,
       direccion = ?,
       observaciones = ?,
       regimen = ?,
       activo = ?
     WHERE id_proveedor = ?`,
    [
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
      data.pais?.trim() || null,
      data.direccion?.trim() || null,
      data.observaciones?.trim() || null,
      data.regimen?.trim() || null,
      data.activo !== false,
      id
    ]
  );
}
