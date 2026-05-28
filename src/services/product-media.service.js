import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';
import { env } from '../config/env.js';
import { getProductById } from './product.service.js';

function toPublicUrl(fileName, productId) {
  return `${env.PUBLIC_UPLOAD_BASE_URL}/products/${productId}/${fileName}`;
}

export async function listProductImages(productId) {
  await getProductById(productId);
  const rows = await query(
    `SELECT
        id_imagen,
        id_producto,
        tipo_origen,
        nombre_archivo_original,
        nombre_archivo_guardado,
        ruta_relativa,
        mime_type,
        tamano_bytes,
        es_principal,
        orden_visualizacion,
        fecha_creacion
     FROM producto_imagenes
     WHERE id_producto = ?
     ORDER BY es_principal DESC, orden_visualizacion ASC, id_imagen DESC`,
    [productId]
  );

  return rows.map((row) => ({
    ...row,
    url: row.ruta_relativa || toPublicUrl(row.nombre_archivo_guardado, row.id_producto)
  }));
}

export async function saveProductImages(productId, files, options = {}) {
  await getProductById(productId);

  if (!Array.isArray(files) || files.length === 0) {
    throw new HttpError(400, 'Debe adjuntar al menos una imagen');
  }

  const currentImages = await query(
    `SELECT COUNT(*) AS total, MAX(orden_visualizacion) AS max_orden, MAX(CASE WHEN es_principal THEN 1 ELSE 0 END) AS tiene_principal
     FROM producto_imagenes
     WHERE id_producto = ?`,
    [productId]
  );

  const meta = currentImages[0] ?? { total: 0, max_orden: 0, tiene_principal: 0 };
  let nextOrder = Number(meta.max_orden ?? 0) + 1;
  const shouldAssignPrimary = Number(meta.tiene_principal ?? 0) === 0;

  for (const [index, file] of files.entries()) {
    await query(
      `INSERT INTO producto_imagenes (
        id_producto,
        tipo_origen,
        nombre_archivo_original,
        nombre_archivo_guardado,
        ruta_relativa,
        mime_type,
        tamano_bytes,
        es_principal,
        orden_visualizacion,
        subido_por
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        productId,
        options.sourceType ?? 'importada',
        file.originalname,
        file.filename,
        toPublicUrl(file.filename, productId),
        file.mimetype,
        file.size,
        shouldAssignPrimary && index === 0,
        nextOrder++,
        options.userId ?? null
      ]
    );
  }

  return listProductImages(productId);
}

export async function setPrimaryProductImage(imageId) {
  const rows = await query(
    `SELECT * FROM producto_imagenes WHERE id_imagen = ?`,
    [imageId]
  );
  const image = rows[0];

  if (!image) {
    throw new HttpError(404, 'Imagen no encontrada');
  }

  await query(
    `UPDATE producto_imagenes SET es_principal = FALSE WHERE id_producto = ?`,
    [image.id_producto]
  );
  await query(
    `UPDATE producto_imagenes SET es_principal = TRUE WHERE id_imagen = ?`,
    [imageId]
  );

  return listProductImages(image.id_producto);
}

export async function deleteProductImage(imageId) {
  const rows = await query(
    `SELECT * FROM producto_imagenes WHERE id_imagen = ?`,
    [imageId]
  );
  const image = rows[0];

  if (!image) {
    throw new HttpError(404, 'Imagen no encontrada');
  }

  const absoluteFile = path.join(env.UPLOAD_DIR, 'products', image.nombre_archivo_guardado);
  await query(`DELETE FROM producto_imagenes WHERE id_imagen = ?`, [imageId]);
  await fs.unlink(absoluteFile).catch(() => null);

  const remaining = await listProductImages(image.id_producto);
  if (remaining.length > 0 && !remaining.some((item) => item.es_principal)) {
    await setPrimaryProductImage(remaining[0].id_imagen);
  }

  return {
    message: 'Imagen eliminada correctamente',
    images: await listProductImages(image.id_producto)
  };
}
