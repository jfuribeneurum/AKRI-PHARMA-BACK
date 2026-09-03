import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { env } from '../config/env.js';
import { query, withTransaction } from '../config/db.js';
import { hsPool } from '../config/hs-db.js';
import { HttpError } from '../utils/http-error.js';

async function getMedicamentoHsNombres(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return {};

  let connection;
  try {
    connection = await hsPool.getConnection();
    const placeholders = uniqueIds.map(() => '?').join(',');
    const [rows] = await connection.query(
      `SELECT id, medicamento AS nombre FROM suhc_new_tbl_medicine WHERE id IN (${placeholders})`,
      uniqueIds
    );
    return Object.fromEntries(rows.map(r => [r.id, r.nombre]));
  } catch {
    return {};
  } finally {
    if (connection) connection.release();
  }
}

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
    `SELECT id_producto, id_medicamento_hs, sku, codigo_control, codigo_barras, nombre_comercial, principio_activo,
            concentracion, presentacion, unidad_medida, registro_invima, cum, consecutivo_cum,
            id_categoria, id_forma, codigo_atc, codigo_dci, clasificacion, id_laboratorio, tipo_producto,
            mx_control, requiere_cadena_frio, temp_min, temp_max, iva_tasa,
            costo_referencia, precio_venta, stock_minimo, stock_maximo, punto_reorden, activo,
            fecha_creacion, fecha_modificacion, creado_por, modificado_por
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
    `SELECT id_laboratorio, nombre, pais, contacto, telefono, email
       FROM laboratorios
      WHERE activo = TRUE
      ORDER BY nombre ASC`
  );
}

export async function listAllProductsForPO() {
  const rows = await query(
    `SELECT p.id_producto, p.id_medicamento_hs, p.sku, p.codigo_control, p.codigo_barras, p.nombre_comercial, p.principio_activo,
            p.concentracion, p.presentacion, p.iva_tasa,
            COALESCE(NULLIF(p.costo_referencia, 0), last_oc.precio_unitario, 0) AS costo_referencia,
            COALESCE(NULLIF(p.precio_venta, 0), last_oc.precio_venta_oc, 0) AS precio_venta,
            p.id_laboratorio, lab.nombre AS laboratorio_nombre
       FROM productos p
       LEFT JOIN laboratorios lab ON lab.id_laboratorio = p.id_laboratorio
       LEFT JOIN (
         SELECT ocd.id_producto,
                ocd.precio_unitario,
                ocd.precio_venta AS precio_venta_oc,
                ROW_NUMBER() OVER (PARTITION BY ocd.id_producto ORDER BY oc.fecha DESC, oc.id_oc DESC) AS rn
           FROM ordenes_compra_detalle ocd
           INNER JOIN ordenes_compra oc ON oc.id_oc = ocd.id_oc
       ) last_oc ON last_oc.id_producto = p.id_producto AND last_oc.rn = 1
      WHERE p.activo = TRUE
      ORDER BY p.nombre_comercial ASC`
  );
  return enrichWithMedicamentoHsNombre(rows);
}

export async function listProductsByLaboratorio(idLaboratorio) {
  const rows = await query(
    `SELECT p.id_producto, p.id_medicamento_hs, p.sku, p.codigo_barras, p.nombre_comercial, p.principio_activo,
            p.concentracion, p.presentacion, p.iva_tasa,
            COALESCE(NULLIF(p.costo_referencia, 0), last_oc.precio_unitario, 0) AS costo_referencia,
            COALESCE(NULLIF(p.precio_venta, 0), last_oc.precio_venta_oc, 0) AS precio_venta,
            lab.nombre AS laboratorio_nombre
       FROM productos p
       LEFT JOIN laboratorios lab ON lab.id_laboratorio = p.id_laboratorio
       LEFT JOIN (
         SELECT ocd.id_producto,
                ocd.precio_unitario,
                ocd.precio_venta AS precio_venta_oc,
                ROW_NUMBER() OVER (PARTITION BY ocd.id_producto ORDER BY oc.fecha DESC, oc.id_oc DESC) AS rn
           FROM ordenes_compra_detalle ocd
           INNER JOIN ordenes_compra oc ON oc.id_oc = ocd.id_oc
       ) last_oc ON last_oc.id_producto = p.id_producto AND last_oc.rn = 1
      WHERE p.id_laboratorio = ? AND p.activo = TRUE
      ORDER BY p.nombre_comercial ASC`,
    [idLaboratorio]
  );
  return enrichWithMedicamentoHsNombre(rows);
}

async function enrichWithMedicamentoHsNombre(rows) {
  const nombresHs = await getMedicamentoHsNombres(rows.map(r => r.id_medicamento_hs));
  return rows.map(r => ({
    ...r,
    nombre_medicamento_hs: r.id_medicamento_hs ? (nombresHs[r.id_medicamento_hs] ?? null) : null
  }));
}

export async function listProducts(search = '', idLaboratorio = null, lote = '') {
  const wildcard = `%${search}%`;
  const loteWildcard = `%${lote}%`;

  const rows = await query(
    `SELECT
        p.id_producto,
        p.id_medicamento_hs,
        p.sku,
        p.codigo_control,
        p.codigo_barras,
        p.nombre_comercial,
        p.principio_activo,
        p.concentracion,
        p.tipo_producto,
        p.mx_control,
        p.requiere_cadena_frio,
        p.precio_venta,
        p.stock_minimo,
        COALESCE(stock.stock_actual, 0) AS stock_actual,
        ff.nombre AS forma_farmaceutica,
        cp.nombre AS categoria,
        lab.nombre AS laboratorio_nombre,
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
     LEFT JOIN laboratorios lab ON lab.id_laboratorio = p.id_laboratorio
     LEFT JOIN (
        SELECT l.id_producto, ROUND(COALESCE(SUM(e.cantidad_disponible), 0), 3) AS stock_actual
        FROM lotes l
        LEFT JOIN existencias e ON e.id_lote = l.id_lote
        GROUP BY l.id_producto
     ) stock ON stock.id_producto = p.id_producto
     WHERE (? = '' OR p.nombre_comercial LIKE ? OR p.sku LIKE ? OR p.principio_activo LIKE ?
             OR p.codigo_barras LIKE ? OR p.codigo_control LIKE ? OR p.id_medicamento_hs LIKE ?)
       AND (? IS NULL OR p.id_laboratorio = ?)
       AND (? = '' OR EXISTS (
             SELECT 1 FROM lotes l WHERE l.id_producto = p.id_producto AND l.numero_lote LIKE ?
           ))
     ORDER BY p.nombre_comercial ASC`,
    [env.PUBLIC_UPLOAD_BASE_URL, search, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, idLaboratorio, idLaboratorio, lote, loteWildcard]
  );

  return enrichWithMedicamentoHsNombre(rows);
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
        p.mx_control,
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
        `SELECT id_laboratorio, nombre, pais, contacto, telefono, email
           FROM laboratorios WHERE id_laboratorio = ?`,
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

function extractLastCumPart(cum) {
  if (cum == null) return null;
  const str = String(cum).trim();
  const match = str.match(/[.\-](\w+)$/);
  return match ? match[1] : str;
}

async function saveTrace({ proceso, subproceso, estado = 'terminado', idUsuario = null, referenciaTipo = null, referenciaId = null, descripcion = null, payload = null }) {
  try {
    await query(
      `INSERT INTO procesos_terminados_trazabilidad
        (proceso, subproceso, estado, id_usuario, referencia_tipo, referencia_id, descripcion, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [proceso, subproceso, estado, idUsuario, referenciaTipo, referenciaId, descripcion, payload ? JSON.stringify(payload) : null]
    );
  } catch { /* trazabilidad es no-crítica */ }
}

export async function checkPresentacionDuplicate(presentacion, idLaboratorio, excludeId = null) {
  if (presentacion == null || presentacion === '') return null;
  const params = excludeId
    ? [presentacion, idLaboratorio ?? null, excludeId]
    : [presentacion, idLaboratorio ?? null];
  const rows = await query(
    `SELECT codigo_control FROM productos
     WHERE presentacion = ? AND id_laboratorio <=> ?
     ${excludeId ? 'AND id_producto != ?' : ''}
     LIMIT 1`,
    params
  );
  return rows[0]?.codigo_control ?? null;
}

export async function getNextControlCode(sku, idLaboratorio, consecutivoCum) {
  if (!sku) return { codigo_control: null, duplicate_cum: null };

  // Formato: {sku}-{id_laboratorio}.{consecutivo_cum}
  // El id_laboratorio es el ID real del lab en BD — no un contador secuencial
  const labPart = idLaboratorio != null ? idLaboratorio : '0';
  const lastCum = extractLastCumPart(consecutivoCum);
  const cumSuffix = lastCum ? `.${lastCum}` : '';
  const codigo_control = `${sku}-${labPart}${cumSuffix}`;

  // Duplicado: mismo consecutivo_cum + mismo laboratorio
  let duplicate_cum = null;
  if (consecutivoCum != null && consecutivoCum !== '') {
    const dupCum = await query(
      `SELECT codigo_control FROM productos WHERE consecutivo_cum = ? AND id_laboratorio <=> ? LIMIT 1`,
      [consecutivoCum, idLaboratorio ?? null]
    );
    duplicate_cum = dupCum[0]?.codigo_control ?? null;
  }

  return { codigo_control, duplicate_cum };
}

export async function createProduct(payload, userId = null) {
  // Duplicado: misma presentacion + mismo laboratorio
  if (payload.presentacion != null) {
    const dupPresentacion = await checkPresentacionDuplicate(payload.presentacion, payload.id_laboratorio);
    if (dupPresentacion) {
      await saveTrace({
        proceso: 'maestro_mx', subproceso: 'presentacion_duplicada_bloqueada', estado: 'cancelado',
        idUsuario: userId, referenciaTipo: 'producto',
        descripcion: `Intento bloqueado: presentación ${payload.presentacion} ya asociada a ${dupPresentacion}`,
        payload: { presentacion: payload.presentacion, id_laboratorio: payload.id_laboratorio, codigo_control_existente: dupPresentacion, sku: payload.sku }
      });
      throw new HttpError(409, `La presentación "${payload.presentacion}" ya está asociada a "${dupPresentacion}" para ese laboratorio.`);
    }
  }

  // Duplicado: mismo consecutivo_cum + mismo laboratorio
  if (payload.consecutivo_cum != null) {
    const existing = await query(
      `SELECT codigo_control FROM productos WHERE consecutivo_cum = ? AND id_laboratorio <=> ? LIMIT 1`,
      [payload.consecutivo_cum, payload.id_laboratorio ?? null]
    );
    if (existing[0]) {
      throw new HttpError(
        409,
        `Ya existe "${existing[0].codigo_control}" con el consecutivo CUM "${payload.consecutivo_cum}" para ese laboratorio. No se puede crear un duplicado.`
      );
    }
  }

  // Formato: {sku}-{id_laboratorio}.{último_número_consecutivo_cum}
  const labPart = payload.id_laboratorio ?? 0;
  const lastCum = extractLastCumPart(payload.consecutivo_cum);
  const cumSuffix = lastCum ? `.${lastCum}` : '';
  const codigoControl = payload.sku ? `${payload.sku}-${labPart}${cumSuffix}` : null;

  const result = await query(
    `INSERT INTO productos (
      id_medicamento_hs, sku, codigo_control, codigo_barras, nombre_comercial, principio_activo, concentracion, presentacion,
      unidad_medida, registro_invima, cum, consecutivo_cum,
      id_categoria, id_forma, codigo_atc, codigo_dci, clasificacion, id_laboratorio, tipo_producto, mx_control,
      requiere_cadena_frio, temp_min, temp_max, iva_tasa,
      stock_minimo, stock_maximo, punto_reorden, activo, creado_por
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.id_medicamento_hs ?? null,
      payload.sku,
      codigoControl,
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
      payload.codigo_dci ?? null,
      payload.clasificacion ?? null,
      payload.id_laboratorio ?? null,
      payload.tipo_producto ?? 'medicamento',
      payload.mx_control ?? false,
      payload.requiere_cadena_frio ?? false,
      payload.temp_min ?? null,
      payload.temp_max ?? null,
      payload.iva_tasa ?? 0,
      payload.stock_minimo ?? 0,
      payload.stock_maximo ?? 0,
      payload.punto_reorden ?? 0,
      payload.activo ?? true,
      userId
    ]
  );

  const created = await getProductById(result.insertId);
  await saveTrace({
    proceso: 'maestro_mx', subproceso: 'producto_creado', estado: 'terminado',
    idUsuario: userId, referenciaTipo: 'producto', referenciaId: created.id_producto,
    descripcion: `Producto creado: ${created.codigo_control ?? created.sku}`,
    payload: {
      id_producto: created.id_producto, sku: created.sku, codigo_control: created.codigo_control,
      nombre_comercial: created.nombre_comercial, presentacion: created.presentacion,
      id_laboratorio: created.id_laboratorio, consecutivo_cum: created.consecutivo_cum
    }
  });
  return created;
}

export async function updateProduct(id, payload, userId = null) {
  const current = await ensureProductExists(id);
  const merged = { ...current, ...payload };

  // Duplicado: misma presentacion + mismo laboratorio (excluyendo el propio producto)
  if (merged.presentacion != null) {
    const dupPresentacion = await checkPresentacionDuplicate(merged.presentacion, merged.id_laboratorio, id);
    if (dupPresentacion) {
      await saveTrace({
        proceso: 'maestro_mx', subproceso: 'presentacion_duplicada_bloqueada', estado: 'cancelado',
        idUsuario: userId, referenciaTipo: 'producto', referenciaId: id,
        descripcion: `Edición bloqueada: presentación ${merged.presentacion} ya asociada a ${dupPresentacion}`,
        payload: { id_producto: id, presentacion: merged.presentacion, id_laboratorio: merged.id_laboratorio, codigo_control_existente: dupPresentacion }
      });
      throw new HttpError(409, `La presentación "${merged.presentacion}" ya está asociada a "${dupPresentacion}" para ese laboratorio.`);
    }
  }

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
      codigo_dci = ?,
      clasificacion = ?,
      id_laboratorio = ?,
      tipo_producto = ?,
      mx_control = ?,
      requiere_cadena_frio = ?,
      temp_min = ?,
      temp_max = ?,
      iva_tasa = ?,
      stock_minimo = ?,
      stock_maximo = ?,
      punto_reorden = ?,
      activo = ?,
      modificado_por = ?
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
      merged.codigo_dci ?? null,
      merged.clasificacion ?? null,
      merged.id_laboratorio,
      merged.tipo_producto,
      merged.mx_control,
      merged.requiere_cadena_frio,
      merged.temp_min,
      merged.temp_max,
      merged.iva_tasa,
      merged.stock_minimo,
      merged.stock_maximo,
      merged.punto_reorden,
      merged.activo,
      userId,
      id
    ]
  );

  const updated = await getProductById(id);
  await saveTrace({
    proceso: 'maestro_mx', subproceso: 'producto_actualizado', estado: 'terminado',
    idUsuario: userId, referenciaTipo: 'producto', referenciaId: id,
    descripcion: `Producto actualizado: ${updated.codigo_control ?? updated.sku}`,
    payload: {
      id_producto: id, sku: updated.sku, codigo_control: updated.codigo_control,
      nombre_comercial: updated.nombre_comercial, presentacion: updated.presentacion,
      id_laboratorio: updated.id_laboratorio, consecutivo_cum: updated.consecutivo_cum,
      campos_previos: { presentacion: current.presentacion, id_laboratorio: current.id_laboratorio }
    }
  });
  return updated;
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
