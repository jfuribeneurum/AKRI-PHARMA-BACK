import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { env } from '../config/env.js';
import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';

const MIME_EXTENSION_MAP = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg'
};

function buildUploadUrl(relativePath) {
  return `${env.PUBLIC_UPLOAD_BASE_URL}/${relativePath}`;
}

function normalizeImage(row) {
  return {
    ...row,
    url: buildUploadUrl(row.url_relativa)
  };
}

function parseImageDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(String(dataUrl ?? ''));

  if (!match) {
    throw new HttpError(400, 'Formato de imagen inválido. Se esperaba data URL en base64.');
  }

  const [, mimeType, rawBase64] = match;
  const extension = MIME_EXTENSION_MAP[mimeType.toLowerCase()];

  if (!extension) {
    throw new HttpError(400, `Tipo de imagen no soportado: ${mimeType}`);
  }

  const buffer = Buffer.from(rawBase64, 'base64');
  const maxBytes = env.MAX_IMAGE_SIZE_MB * 1024 * 1024;

  if (buffer.byteLength > maxBytes) {
    throw new HttpError(400, `La imagen excede el máximo permitido de ${env.MAX_IMAGE_SIZE_MB} MB`);
  }

  return { mimeType, extension, buffer };
}

async function ensureProductExists(id) {
  const rows = await query(
    `SELECT id_producto, id_medicamento_hs, sku, codigo_barras, nombre_comercial, principio_activo,
            concentracion, presentacion, unidad_medida, registro_invima, cum, consecutivo_cum,
            id_categoria, id_forma, codigo_atc, id_laboratorio, tipo_producto,
            requiere_receta, es_controlado, requiere_cadena_frio, temp_min, temp_max, iva_tasa,
            costo_referencia, precio_venta, stock_minimo, stock_maximo, punto_reorden, activo,
            fecha_creacion, fecha_modificacion
     FROM productos
     WHERE id_producto = ?`,
    [id]
  );

  const product = rows[0];
  if (!product) {
    throw new HttpError(404, 'Producto no encontrado');
  }

  return product;
}

export async function listLaboratorios() {
  return query(
    `SELECT id_proveedor AS id_laboratorio,
            COALESCE(razon_social, nombre) AS nombre,
            ciudad AS pais,
            nombres AS contacto,
            telefono,
            email
       FROM proveedores
      WHERE activo = TRUE
      ORDER BY COALESCE(razon_social, nombre) ASC`
  );
}

export async function listProducts(search = '') {
  const wildcard = `%${search}%`;

  return query(
    `SELECT
        p.id_producto,
        p.id_medicamento_hs,
        p.sku,
        p.codigo_barras,
        p.nombre_comercial,
        p.principio_activo,
        p.concentracion,
        p.tipo_producto,
        p.requiere_receta,
        p.es_controlado,
        p.requiere_cadena_frio,
        p.precio_venta,
        p.stock_minimo,
        COALESCE(stock.stock_actual, 0) AS stock_actual,
        ff.nombre AS forma_farmaceutica,
        cp.nombre AS categoria,
        COALESCE(lab.razon_social, lab.nombre) AS laboratorio_nombre,
        (
          SELECT CONCAT(?, '/', pi.url_relativa)
          FROM productos_imagenes pi
          WHERE pi.id_producto = p.id_producto
          ORDER BY pi.es_principal DESC, pi.fecha_creacion DESC
          LIMIT 1
        ) AS imagen_principal_url
     FROM productos p
     LEFT JOIN formas_farmaceuticas ff ON ff.id_forma = p.id_forma
     LEFT JOIN categorias_producto cp ON cp.id_categoria = p.id_categoria
     LEFT JOIN proveedores lab ON lab.id_proveedor = p.id_laboratorio
     LEFT JOIN (
        SELECT l.id_producto, ROUND(COALESCE(SUM(e.cantidad_disponible), 0), 3) AS stock_actual
        FROM lotes l
        LEFT JOIN existencias e ON e.id_lote = l.id_lote
        GROUP BY l.id_producto
     ) stock ON stock.id_producto = p.id_producto
     WHERE p.id_medicamento_hs IS NOT NULL
       AND p.sku IS NOT NULL AND p.sku != ''
       AND p.nombre_comercial IS NOT NULL AND p.nombre_comercial != ''
       AND (? = '' OR p.nombre_comercial LIKE ? OR p.sku LIKE ? OR p.principio_activo LIKE ? OR p.codigo_barras LIKE ?)
     ORDER BY p.nombre_comercial ASC`,
    [env.PUBLIC_UPLOAD_BASE_URL, search, wildcard, wildcard, wildcard, wildcard]
  );
}


export async function getProductByBarcode(barcode) {
  const rows = await query(
    `SELECT
        p.id_producto,
        p.sku,
        p.codigo_barras,
        p.nombre_comercial,
        p.principio_activo,
        p.concentracion,
        p.unidad_medida,
        p.tipo_producto,
        p.requiere_receta,
        p.es_controlado,
        p.requiere_cadena_frio,
        p.temp_min,
        p.temp_max,
        p.costo_referencia,
        p.precio_venta,
        p.stock_minimo,
        COALESCE(stock.stock_actual, 0) AS stock_actual,
        ff.nombre AS forma_farmaceutica,
        cp.nombre AS categoria,
        (
          SELECT CONCAT(?, '/', pi.url_relativa)
          FROM productos_imagenes pi
          WHERE pi.id_producto = p.id_producto
          ORDER BY pi.es_principal DESC, pi.fecha_creacion DESC
          LIMIT 1
        ) AS imagen_principal_url
     FROM productos p
     LEFT JOIN formas_farmaceuticas ff ON ff.id_forma = p.id_forma
     LEFT JOIN categorias_producto cp ON cp.id_categoria = p.id_categoria
     LEFT JOIN (
        SELECT l.id_producto, ROUND(COALESCE(SUM(e.cantidad_disponible), 0), 3) AS stock_actual
        FROM lotes l
        LEFT JOIN existencias e ON e.id_lote = l.id_lote
        GROUP BY l.id_producto
     ) stock ON stock.id_producto = p.id_producto
     WHERE p.codigo_barras = ? AND p.activo = TRUE
     LIMIT 1`,
    [env.PUBLIC_UPLOAD_BASE_URL, barcode]
  );

  return rows[0] ?? null;
}

export async function listProductImages(idProduct) {
  await ensureProductExists(idProduct);
  const rows = await query(
    `SELECT id_imagen, id_producto, tipo_origen, nombre_archivo, mime_type, tamano_bytes,
            url_relativa, es_principal, descripcion, metadata, fecha_creacion
     FROM productos_imagenes
     WHERE id_producto = ?
     ORDER BY es_principal DESC, fecha_creacion DESC`,
    [idProduct]
  );

  return rows.map(normalizeImage);
}

export async function getProductById(id) {
  const product = await ensureProductExists(id);

  const [ffRow] = product.id_forma
    ? await query(
        `SELECT nombre AS forma_farmaceutica FROM formas_farmaceuticas WHERE id_forma = ?`,
        [product.id_forma]
      )
    : [{}];
  product.forma_farmaceutica = ffRow?.forma_farmaceutica ?? '';

  const [stockSummary] = await query(
    `SELECT ROUND(COALESCE(SUM(e.cantidad_disponible), 0), 3) AS stock_total,
            ROUND(COALESCE(SUM(e.cantidad_cuarentena), 0), 3) AS stock_cuarentena,
            ROUND(COALESCE(SUM(e.cantidad_reservada), 0), 3) AS stock_reservada
     FROM lotes l
     LEFT JOIN existencias e ON e.id_lote = l.id_lote
     WHERE l.id_producto = ?`,
    [id]
  );

  const stockLotes = await query(
    `SELECT
        l.id_lote,
        l.numero_lote,
        l.fecha_vencimiento,
        l.estado,
        a.nombre AS almacen,
        u.nombre AS ubicacion,
        ROUND(COALESCE(e.cantidad_disponible, 0), 3) AS cantidad_disponible,
        ROUND(COALESCE(e.cantidad_cuarentena, 0), 3) AS cantidad_cuarentena,
        ROUND(COALESCE(e.cantidad_reservada, 0), 3) AS cantidad_reservada
     FROM lotes l
     LEFT JOIN existencias e ON e.id_lote = l.id_lote
     LEFT JOIN almacenes a ON a.id_almacen = e.id_almacen
     LEFT JOIN ubicaciones_almacen u ON u.id_ubicacion = e.id_ubicacion
     WHERE l.id_producto = ?
     ORDER BY l.fecha_vencimiento ASC, l.numero_lote ASC`,
    [id]
  );

  const images = await listProductImages(id);

  const labRows = product.id_laboratorio
    ? await query(
        `SELECT id_proveedor AS id_laboratorio,
                COALESCE(razon_social, nombre) AS nombre,
                ciudad AS pais,
                nombres AS contacto,
                telefono,
                email
           FROM proveedores WHERE id_proveedor = ?`,
        [product.id_laboratorio]
      )
    : [];

  return {
    ...product,
    stock_total: Number(stockSummary?.stock_total ?? 0),
    stock_cuarentena: Number(stockSummary?.stock_cuarentena ?? 0),
    stock_reservada: Number(stockSummary?.stock_reservada ?? 0),
    imagen_principal_url: images[0]?.url ?? null,
    images,
    stock_lotes: stockLotes,
    laboratorio: labRows[0] ?? null
  };
}

export async function createProduct(payload) {
  const result = await query(
    `INSERT INTO productos (
      id_medicamento_hs, sku, codigo_barras, nombre_comercial, principio_activo, concentracion, presentacion,
      unidad_medida, registro_invima, cum, consecutivo_cum,
      id_categoria, id_forma, codigo_atc, id_laboratorio, tipo_producto, requiere_receta,
      es_controlado, requiere_cadena_frio, temp_min, temp_max, iva_tasa, costo_referencia,
      precio_venta, stock_minimo, stock_maximo, punto_reorden, activo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.id_medicamento_hs ?? null,
      payload.sku,
      payload.codigo_barras ?? null,
      payload.nombre_comercial,
      payload.principio_activo ?? null,
      payload.concentracion ?? null,
      payload.presentacion ?? null,
      payload.unidad_medida ?? 'UND',
      payload.registro_invima ?? null,
      payload.cum ?? null,
      payload.consecutivo_cum ?? null,
      payload.id_categoria ?? null,
      payload.id_forma ?? null,
      payload.codigo_atc ?? null,
      payload.id_laboratorio ?? null,
      payload.tipo_producto ?? 'medicamento',
      payload.requiere_receta ?? false,
      payload.es_controlado ?? false,
      payload.requiere_cadena_frio ?? false,
      payload.temp_min ?? null,
      payload.temp_max ?? null,
      payload.iva_tasa ?? 0,
      payload.costo_referencia ?? 0,
      payload.precio_venta ?? 0,
      payload.stock_minimo ?? 0,
      payload.stock_maximo ?? 0,
      payload.punto_reorden ?? 0,
      payload.activo ?? true
    ]
  );

  return getProductById(result.insertId);
}

export async function updateProduct(id, payload) {
  const current = await ensureProductExists(id);
  const merged = { ...current, ...payload };

  await query(
    `UPDATE productos SET
      id_medicamento_hs = ?,
      codigo_barras = ?,
      nombre_comercial = ?,
      principio_activo = ?,
      concentracion = ?,
      presentacion = ?,
      unidad_medida = ?,
      registro_invima = ?,
      cum = ?,
      consecutivo_cum = ?,
      id_categoria = ?,
      id_forma = ?,
      codigo_atc = ?,
      id_laboratorio = ?,
      tipo_producto = ?,
      requiere_receta = ?,
      es_controlado = ?,
      requiere_cadena_frio = ?,
      temp_min = ?,
      temp_max = ?,
      iva_tasa = ?,
      costo_referencia = ?,
      precio_venta = ?,
      stock_minimo = ?,
      stock_maximo = ?,
      punto_reorden = ?,
      activo = ?
    WHERE id_producto = ?`,
    [
      merged.id_medicamento_hs ?? null,
      merged.codigo_barras,
      merged.nombre_comercial,
      merged.principio_activo,
      merged.concentracion,
      merged.presentacion ?? null,
      merged.unidad_medida,
      merged.registro_invima ?? null,
      merged.cum ?? null,
      merged.consecutivo_cum ?? null,
      merged.id_categoria,
      merged.id_forma,
      merged.codigo_atc,
      merged.id_laboratorio,
      merged.tipo_producto,
      merged.requiere_receta,
      merged.es_controlado,
      merged.requiere_cadena_frio,
      merged.temp_min,
      merged.temp_max,
      merged.iva_tasa,
      merged.costo_referencia,
      merged.precio_venta,
      merged.stock_minimo,
      merged.stock_maximo,
      merged.punto_reorden,
      merged.activo,
      id
    ]
  );

  return getProductById(id);
}

export async function saveProductImage(idProduct, payload, userId) {
  await ensureProductExists(idProduct);
  const { mimeType, extension, buffer } = parseImageDataUrl(payload.image_base64);

  const productDir = path.join(env.UPLOAD_DIR, 'products', String(idProduct));
  await fs.mkdir(productDir, { recursive: true });

  const fileName = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const absolutePath = path.join(productDir, fileName);
  await fs.writeFile(absolutePath, buffer);

  const relativePath = path.posix.join('products', String(idProduct), fileName);

  return withTransaction(async (connection) => {
    const [countRows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM productos_imagenes WHERE id_producto = ?`,
      [idProduct]
    );

    const shouldBePrimary = payload.es_principal ?? Number(countRows[0]?.total ?? 0) === 0;

    if (shouldBePrimary) {
      await connection.execute(
        `UPDATE productos_imagenes SET es_principal = FALSE WHERE id_producto = ?`,
        [idProduct]
      );
    }

    const [result] = await connection.execute(
      `INSERT INTO productos_imagenes (
        id_producto, tipo_origen, nombre_archivo, mime_type, tamano_bytes,
        url_relativa, es_principal, descripcion, metadata, id_usuario
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        idProduct,
        payload.tipo_origen ?? 'importada',
        fileName,
        mimeType,
        buffer.byteLength,
        relativePath,
        shouldBePrimary,
        payload.descripcion ?? null,
        payload.metadata ? JSON.stringify(payload.metadata) : null,
        userId ?? null
      ]
    );

    const [rows] = await connection.execute(
      `SELECT id_imagen, id_producto, tipo_origen, nombre_archivo, mime_type, tamano_bytes,
              url_relativa, es_principal, descripcion, metadata, fecha_creacion
       FROM productos_imagenes
       WHERE id_imagen = ?`,
      [result.insertId]
    );

    return normalizeImage(rows[0]);
  });
}
