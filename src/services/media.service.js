import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { env } from '../config/env.js';
import { query } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storageRoot = path.resolve(__dirname, '..', '..', env.STORAGE_DIR);
const publicRoot = env.PUBLIC_UPLOADS_PATH.replace(/\/$/, '');
const maxImageBytes = 10 * 1024 * 1024;

function extensionFromMime(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      throw new HttpError(400, `Tipo de imagen no soportado: ${mimeType}`);
  }
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl ?? '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

  if (!match) {
    throw new HttpError(400, 'Formato de imagen inválido. Se esperaba data URL base64');
  }

  const mimeType = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');

  if (!buffer.byteLength) {
    throw new HttpError(400, 'La imagen recibida está vacía');
  }

  if (buffer.byteLength > maxImageBytes) {
    throw new HttpError(413, 'La imagen supera el tamaño máximo permitido de 10MB');
  }

  return {
    mimeType,
    extension: extensionFromMime(mimeType),
    buffer
  };
}

export async function listProductImages(productId) {
  return query(
    `SELECT
        id_imagen,
        id_producto,
        tipo_fuente,
        nombre_archivo,
        mime_type,
        extension,
        ruta_relativa,
        url_publica,
        tamano_bytes,
        alt_text,
        es_principal,
        metadata,
        creado_por,
        fecha_creacion
     FROM producto_imagenes
     WHERE id_producto = ?
     ORDER BY es_principal DESC, fecha_creacion DESC`,
    [productId]
  );
}

export async function saveProductImage(productId, payload, userId) {
  const [product] = await query('SELECT id_producto FROM productos WHERE id_producto = ?', [productId]);

  if (!product) {
    throw new HttpError(404, 'Producto no encontrado');
  }

  const { mimeType, extension, buffer } = parseDataUrl(payload.data_url);
  const productDir = path.join(storageRoot, 'product-images', String(productId));
  await fs.mkdir(productDir, { recursive: true });

  const filename = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const absolutePath = path.join(productDir, filename);
  const relativePath = path.posix.join('product-images', String(productId), filename);
  const publicUrl = `${publicRoot}/${relativePath}`;

  await fs.writeFile(absolutePath, buffer);

  const [imagesCount] = await query(
    'SELECT COUNT(*) AS total FROM producto_imagenes WHERE id_producto = ?',
    [productId]
  );

  const shouldBePrimary = Boolean(payload.es_principal) || Number(imagesCount.total) === 0;

  if (shouldBePrimary) {
    await query('UPDATE producto_imagenes SET es_principal = FALSE WHERE id_producto = ?', [productId]);
  }

  const result = await query(
    `INSERT INTO producto_imagenes (
      id_producto,
      tipo_fuente,
      nombre_archivo,
      mime_type,
      extension,
      ruta_relativa,
      url_publica,
      tamano_bytes,
      alt_text,
      es_principal,
      metadata,
      creado_por
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      productId,
      payload.tipo_fuente ?? 'importada',
      payload.nombre_archivo ?? filename,
      mimeType,
      extension,
      relativePath,
      publicUrl,
      buffer.byteLength,
      payload.alt_text ?? null,
      shouldBePrimary,
      payload.metadata ? JSON.stringify(payload.metadata) : null,
      userId ?? null
    ]
  );

  const images = await listProductImages(productId);
  const image = images.find((item) => Number(item.id_imagen) === Number(result.insertId));

  if (!image) {
    throw new HttpError(500, 'La imagen fue registrada pero no pudo recuperarse');
  }

  return image;
}
