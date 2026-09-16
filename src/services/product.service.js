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

export async function enrichWithMedicamentoHsNombre(rows) {
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

// Completa codigo_dci para productos ya creados y enlazados a HealthSphere
// (id_medicamento_hs) que quedaron sin ese campo — la mayoría porque se
// crearon antes de que Maestro MX empezara a traerlo desde HS. Usa el mismo
// criterio que ya usa el buscador de medicamentos HS (MIN(dci) cuando un
// medicamento combinado tiene más de un dci) para quedar consistente con lo
// que se ve al buscar. Es idempotente: solo toca productos con
// codigo_dci IS NULL, así que puede volver a correrse sin riesgo.
export async function backfillCodigoDciFromHs(userId = null) {
  const candidates = await query(
    `SELECT id_producto, id_medicamento_hs, sku, nombre_comercial
       FROM productos
      WHERE activo = TRUE AND id_medicamento_hs IS NOT NULL AND codigo_dci IS NULL`
  );
  if (!candidates.length) {
    return { candidatos: 0, actualizados: 0, muestra: [] };
  }

  let connection;
  let dciByMed = new Map();
  try {
    connection = await hsPool.getConnection();
    const ids = [...new Set(candidates.map((c) => c.id_medicamento_hs))];
    const placeholders = ids.map(() => '?').join(',');
    const [dciRows] = await connection.query(
      `SELECT idMedicamento, MIN(dci) AS dci
         FROM suhc_new_tbl_medicine_dci
        WHERE idMedicamento IN (${placeholders})
        GROUP BY idMedicamento`,
      ids
    );
    dciByMed = new Map(dciRows.map((r) => [r.idMedicamento, r.dci]));
  } finally {
    if (connection) connection.release();
  }

  let actualizados = 0;
  const muestra = [];
  for (const p of candidates) {
    const dci = dciByMed.get(p.id_medicamento_hs);
    if (dci == null) continue;
    await query(`UPDATE productos SET codigo_dci = ? WHERE id_producto = ?`, [dci, p.id_producto]);
    actualizados++;
    if (muestra.length < 10) {
      muestra.push({ id_producto: p.id_producto, sku: p.sku, nombre_comercial: p.nombre_comercial, codigo_dci: dci });
    }
  }

  await saveTrace({
    proceso: 'maestro_mx', subproceso: 'backfill_codigo_dci', estado: 'terminado',
    idUsuario: userId, referenciaTipo: 'producto',
    descripcion: `Backfill de codigo_dci: ${actualizados} de ${candidates.length} productos actualizados`,
    payload: { candidatos: candidates.length, actualizados }
  });

  return { candidatos: candidates.length, actualizados, muestra };
}

// Completa concentracion para productos ya creados y enlazados a
// HealthSphere que quedaron sin ese campo — mismo patrón que
// backfillCodigoDciFromHs: se crearon antes de que Maestro MX empezara a
// traer este dato desde HS al vincular el medicamento. Copia directa
// (concentracion es texto libre en ambos lados, sin necesidad de match).
// Idempotente: solo toca productos con concentracion vacía/NULL.
export async function backfillConcentracionFromHs(userId = null) {
  const candidates = await query(
    `SELECT id_producto, id_medicamento_hs, sku, nombre_comercial
       FROM productos
      WHERE activo = TRUE AND id_medicamento_hs IS NOT NULL
        AND (concentracion IS NULL OR TRIM(concentracion) = '')`
  );
  if (!candidates.length) {
    return { candidatos: 0, actualizados: 0, muestra: [] };
  }

  let connection;
  let concByMed = new Map();
  try {
    connection = await hsPool.getConnection();
    const ids = [...new Set(candidates.map((c) => c.id_medicamento_hs))];
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await connection.query(
      `SELECT id, concentracion FROM suhc_new_tbl_medicine WHERE id IN (${placeholders})`,
      ids
    );
    concByMed = new Map(rows.map((r) => [r.id, r.concentracion]));
  } finally {
    if (connection) connection.release();
  }

  let actualizados = 0;
  const muestra = [];
  for (const p of candidates) {
    const concentracion = concByMed.get(p.id_medicamento_hs);
    if (!concentracion || !String(concentracion).trim()) continue;
    await query(`UPDATE productos SET concentracion = ? WHERE id_producto = ?`, [concentracion, p.id_producto]);
    actualizados++;
    if (muestra.length < 10) {
      muestra.push({ id_producto: p.id_producto, sku: p.sku, nombre_comercial: p.nombre_comercial, concentracion });
    }
  }

  await saveTrace({
    proceso: 'maestro_mx', subproceso: 'backfill_concentracion', estado: 'terminado',
    idUsuario: userId, referenciaTipo: 'producto',
    descripcion: `Backfill de concentracion: ${actualizados} de ${candidates.length} productos actualizados`,
    payload: { candidatos: candidates.length, actualizados }
  });

  return { candidatos: candidates.length, actualizados, muestra };
}

// Los códigos ATC (estándar WHO ATC/DDD) son jerárquicos por longitud:
// 1 char = nivel 1 (ej. "N"), 3 = nivel 2 ("N02"), 4 = nivel 3 ("N02C"),
// 5 = nivel 4 ("N02CX"), 7 = nivel 5 ("N02CX08"). clasificacion_atc.codigo_atc
// es FK de sí mismo vía codigo_padre, así que para insertar un código hoja
// hace falta insertar primero toda su cadena de ancestros si no existen.
const ATC_LEVEL_BREAKPOINTS = [1, 3, 4, 5, 7];

function atcAncestorChain(codigoRaw) {
  // Se recorta antes de todo: un código con espacios (visto en datos reales
  // de HS, ej. " A10BH01") desalinea las longitudes de nivel y hace que ni
  // el código ni sus padres calcen con ningún quiebre.
  const codigo = String(codigoRaw).trim();
  const chain = [];
  for (let i = 0; i < ATC_LEVEL_BREAKPOINTS.length; i++) {
    const len = ATC_LEVEL_BREAKPOINTS[i];
    if (len >= codigo.length) break;
    chain.push({ codigo: codigo.slice(0, len), nivel: i + 1 });
  }
  // El código completo siempre queda como último eslabón (la hoja), aunque
  // su longitud no calce con ningún quiebre estándar — HS trae algunos
  // códigos que no siguen el formato WHO ATC exacto (ej. "902018", sin la
  // letra inicial); igual deben poder guardarse para no bloquear el
  // producto, sin bloquear el resto del backfill por un dato sucio.
  chain.push({ codigo, nivel: Math.min(chain.length + 1, 5) });
  return chain;
}

// Inserta en clasificacion_atc los códigos (y toda su cadena de padres) que
// HealthSphere trae pero que no existen en el catálogo local — sin esto,
// backfillCodigoAtcFromHs no puede guardar esos códigos por la FK. HS solo
// da el código, no la descripción oficial WHO ATC, así que las filas nuevas
// quedan con una descripción temporal (nombre del medicamento para el
// código hoja, genérica para los padres intermedios) marcada explícitamente
// como pendiente de revisar contra el estándar oficial — a petición del
// usuario, para no dejar el campo NOT NULL vacío ni bloquear el backfill.
async function ensureClasificacionAtcEntries(codigosConNombre) {
  const existentes = new Set((await query(`SELECT codigo_atc FROM clasificacion_atc`)).map((r) => r.codigo_atc));

  const porInsertar = new Map(); // codigo -> { nivel, codigo_padre, nombreMedicamento? }
  for (const [codigo, nombreMedicamento] of codigosConNombre) {
    const chain = atcAncestorChain(codigo);
    for (let i = 0; i < chain.length; i++) {
      const { codigo: c, nivel } = chain[i];
      if (existentes.has(c) || porInsertar.has(c)) continue;
      const codigoPadre = i > 0 ? chain[i - 1].codigo : null;
      const esHoja = c === codigo;
      porInsertar.set(c, { nivel, codigo_padre: codigoPadre, nombreMedicamento: esHoja ? nombreMedicamento : null });
    }
  }

  let insertados = 0;
  // Se inserta ordenado por nivel para que el padre siempre exista antes que el hijo (FK codigo_padre).
  const ordenados = [...porInsertar.entries()].sort((a, b) => a[1].nivel - b[1].nivel);
  for (const [codigo, { nivel, codigo_padre, nombreMedicamento }] of ordenados) {
    const descripcion = nombreMedicamento
      ? `${nombreMedicamento} (código ATC traído de HealthSphere, pendiente de revisar contra el estándar WHO ATC oficial)`
      : `Clasificación ATC nivel ${nivel} — ${codigo} (generado automáticamente desde HealthSphere, pendiente de revisar contra el estándar WHO ATC oficial)`;
    await query(
      `INSERT IGNORE INTO clasificacion_atc (codigo_atc, nivel, descripcion_en, descripcion_es, codigo_padre) VALUES (?, ?, ?, ?, ?)`,
      [codigo, nivel, descripcion, descripcion, codigo_padre]
    );
    insertados++;
  }
  return insertados;
}

// Completa codigo_atc para productos ya creados y enlazados a HealthSphere
// que quedaron sin ese campo — mismo patrón que backfillConcentracionFromHs.
// A diferencia de los demás, productos.codigo_atc tiene un FK contra
// clasificacion_atc: varios códigos ATC que trae HS no existían en ese
// catálogo local (catálogo desactualizado/incompleto), así que primero se
// completa la jerarquía faltante (ensureClasificacionAtcEntries) y luego se
// aplica el backfill. Idempotente: solo toca codigo_atc vacío/NULL, y el
// insert al catálogo usa INSERT IGNORE.
export async function backfillCodigoAtcFromHs(userId = null) {
  const candidates = await query(
    `SELECT id_producto, id_medicamento_hs, sku, nombre_comercial
       FROM productos
      WHERE activo = TRUE AND id_medicamento_hs IS NOT NULL
        AND (codigo_atc IS NULL OR TRIM(codigo_atc) = '')`
  );
  if (!candidates.length) {
    return { candidatos: 0, actualizados: 0, catalogo_atc_completado: 0, muestra: [] };
  }

  let connection;
  let atcByMed = new Map();
  let nombreByMed = new Map();
  try {
    connection = await hsPool.getConnection();
    const ids = [...new Set(candidates.map((c) => c.id_medicamento_hs))];
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await connection.query(
      `SELECT id, ATC, medicamento FROM suhc_new_tbl_medicine WHERE id IN (${placeholders})`,
      ids
    );
    atcByMed = new Map(rows.map((r) => [r.id, r.ATC ? String(r.ATC).trim() : r.ATC]));
    nombreByMed = new Map(rows.map((r) => [r.id, r.medicamento]));
  } finally {
    if (connection) connection.release();
  }

  const codigosConNombre = [];
  for (const p of candidates) {
    const codigo = atcByMed.get(p.id_medicamento_hs);
    if (codigo && String(codigo).trim()) {
      codigosConNombre.push([codigo, nombreByMed.get(p.id_medicamento_hs) ?? p.nombre_comercial]);
    }
  }
  const catalogoAtcCompletado = await ensureClasificacionAtcEntries(codigosConNombre);

  const catalogoValido = new Set((await query(`SELECT codigo_atc FROM clasificacion_atc`)).map((r) => r.codigo_atc));

  let actualizados = 0;
  const muestra = [];
  for (const p of candidates) {
    const codigoAtc = atcByMed.get(p.id_medicamento_hs);
    if (!codigoAtc || !String(codigoAtc).trim() || !catalogoValido.has(codigoAtc)) continue;
    await query(`UPDATE productos SET codigo_atc = ? WHERE id_producto = ?`, [codigoAtc, p.id_producto]);
    actualizados++;
    if (muestra.length < 10) {
      muestra.push({ id_producto: p.id_producto, sku: p.sku, nombre_comercial: p.nombre_comercial, codigo_atc: codigoAtc });
    }
  }

  await saveTrace({
    proceso: 'maestro_mx', subproceso: 'backfill_codigo_atc', estado: 'terminado',
    idUsuario: userId, referenciaTipo: 'producto',
    descripcion: `Backfill de codigo_atc: ${actualizados} de ${candidates.length} productos actualizados (${catalogoAtcCompletado} filas nuevas en clasificacion_atc)`,
    payload: { candidatos: candidates.length, actualizados, catalogoAtcCompletado }
  });

  return { candidatos: candidates.length, actualizados, catalogo_atc_completado: catalogoAtcCompletado, muestra };
}

// Completa unidad_medida para productos ya creados y enlazados a
// HealthSphere que quedaron con el genérico "UND" (el valor por defecto de
// createProduct/updateProduct cuando no se indica ninguno) en vez de la
// unidad real de HS (AMPOLLA, VIAL, TABLETA, etc.). A diferencia de los
// demás campos de este grupo, acá el problema no es un NULL sino un valor
// incorrecto por defecto, así que también se sobreescribe cuando es 'UND'
// y HS trae algo distinto y real.
export async function backfillUnidadMedidaFromHs(userId = null) {
  const candidates = await query(
    `SELECT id_producto, id_medicamento_hs, sku, nombre_comercial, unidad_medida
       FROM productos
      WHERE activo = TRUE AND id_medicamento_hs IS NOT NULL
        AND (unidad_medida IS NULL OR TRIM(unidad_medida) = '' OR unidad_medida = 'UND')`
  );
  if (!candidates.length) {
    return { candidatos: 0, actualizados: 0, muestra: [] };
  }

  let connection;
  let unidadByMed = new Map();
  try {
    connection = await hsPool.getConnection();
    const ids = [...new Set(candidates.map((c) => c.id_medicamento_hs))];
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await connection.query(
      `SELECT m.id, u.descripcion AS unidad
         FROM suhc_new_tbl_medicine m
         LEFT JOIN suhc_new_tbl_maestrasdetalle u ON u.id = m.idUnidadDosificacion
        WHERE m.id IN (${placeholders})`,
      ids
    );
    unidadByMed = new Map(rows.map((r) => [r.id, r.unidad]));
  } finally {
    if (connection) connection.release();
  }

  let actualizados = 0;
  const muestra = [];
  for (const p of candidates) {
    const hsUnidad = unidadByMed.get(p.id_medicamento_hs);
    if (!hsUnidad || !String(hsUnidad).trim()) continue;
    if (hsUnidad.trim().toUpperCase() === (p.unidad_medida || '').trim().toUpperCase()) continue;
    await query(`UPDATE productos SET unidad_medida = ? WHERE id_producto = ?`, [hsUnidad, p.id_producto]);
    actualizados++;
    if (muestra.length < 10) {
      muestra.push({ id_producto: p.id_producto, sku: p.sku, nombre_comercial: p.nombre_comercial, unidad_medida_anterior: p.unidad_medida, unidad_medida: hsUnidad });
    }
  }

  await saveTrace({
    proceso: 'maestro_mx', subproceso: 'backfill_unidad_medida', estado: 'terminado',
    idUsuario: userId, referenciaTipo: 'producto',
    descripcion: `Backfill de unidad_medida: ${actualizados} de ${candidates.length} productos actualizados`,
    payload: { candidatos: candidates.length, actualizados }
  });

  return { candidatos: candidates.length, actualizados, muestra };
}

// Misma normalización/algoritmo que matchForma() en
// maestro-mx.component.ts (frontend), usado ahí cuando se enlaza un
// medicamento de HS nuevo: coincidencia exacta primero, si no la parcial
// más cercana en longitud. Se replica acá para poder resolverla también en
// productos ya creados, sin depender de que el usuario reabra el formulario.
function normalizarTextoForma(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function matchForma(hsText, formas) {
  if (!hsText) return null;
  const hsNorm = normalizarTextoForma(hsText);

  const exact = formas.find((f) => normalizarTextoForma(f.nombre) === hsNorm);
  if (exact) return exact.id_forma;

  let best = null;
  let bestDiff = Infinity;
  for (const f of formas) {
    const fNorm = normalizarTextoForma(f.nombre);
    if (hsNorm.includes(fNorm) || fNorm.includes(hsNorm)) {
      const diff = Math.abs(fNorm.length - hsNorm.length);
      if (diff < bestDiff) {
        best = f;
        bestDiff = diff;
      }
    }
  }
  return best?.id_forma ?? null;
}

// Completa id_forma para productos ya creados y enlazados a HealthSphere que
// quedaron sin ese campo — la mayoría porque se crearon antes de que Maestro
// MX empezara a traerlo/matchearlo desde HS al vincular el medicamento. Sin
// esto, editar cualquiera de ellos queda bloqueado con "Este medicamento no
// tiene forma farmacéutica en HealthSphere" aunque HS sí la tenga — el
// mensaje solo refleja que nunca se sincronizó localmente. Idempotente:
// solo toca productos con id_forma IS NULL.
export async function backfillFormaFarmaceuticaFromHs(userId = null) {
  const candidates = await query(
    `SELECT id_producto, id_medicamento_hs, sku, nombre_comercial
       FROM productos
      WHERE activo = TRUE AND id_medicamento_hs IS NOT NULL AND id_forma IS NULL`
  );
  if (!candidates.length) {
    return { candidatos: 0, actualizados: 0, muestra: [] };
  }

  const formas = await query(`SELECT id_forma, nombre FROM formas_farmaceuticas`);

  let connection;
  let formaTextByMed = new Map();
  try {
    connection = await hsPool.getConnection();
    const ids = [...new Set(candidates.map((c) => c.id_medicamento_hs))];
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await connection.query(
      `SELECT m.id, d.descripcion AS forma_desc
         FROM suhc_new_tbl_medicine m
         LEFT JOIN suhc_new_tbl_maestrasdetalle d ON d.id = m.idFormaFarmaceutica AND d.idMaestra = 1
        WHERE m.id IN (${placeholders})`,
      ids
    );
    formaTextByMed = new Map(rows.map((r) => [r.id, r.forma_desc]));
  } finally {
    if (connection) connection.release();
  }

  let actualizados = 0;
  const muestra = [];
  for (const p of candidates) {
    const hsText = formaTextByMed.get(p.id_medicamento_hs);
    const idForma = matchForma(hsText, formas);
    if (idForma == null) continue;
    await query(`UPDATE productos SET id_forma = ? WHERE id_producto = ?`, [idForma, p.id_producto]);
    actualizados++;
    if (muestra.length < 10) {
      muestra.push({ id_producto: p.id_producto, sku: p.sku, nombre_comercial: p.nombre_comercial, forma_hs: hsText, id_forma: idForma });
    }
  }

  await saveTrace({
    proceso: 'maestro_mx', subproceso: 'backfill_id_forma', estado: 'terminado',
    idUsuario: userId, referenciaTipo: 'producto',
    descripcion: `Backfill de id_forma: ${actualizados} de ${candidates.length} productos actualizados`,
    payload: { candidatos: candidates.length, actualizados }
  });

  return { candidatos: candidates.length, actualizados, muestra };
}

// El identificador que realmente distingue un registro sanitario de otro es
// el CUM completo (cum + consecutivo_cum, asignado por INVIMA) — no el
// laboratorio ni la presentación (tamaño de empaque), que se repiten
// constantemente entre productos que no tienen nada que ver entre sí (ej.
// "30 tabletas" o un consecutivo terminado en el mismo dígito). Comparar por
// esos campos sueltos genera falsos positivos: dos medicamentos distintos del
// mismo laboratorio quedaban bloqueados por coincidir en presentación o en el
// último dígito del consecutivo, aun con CUM base totalmente diferente.
export async function checkCumDuplicate(cum, consecutivoCum, excludeId = null) {
  if (cum == null || cum === '') return null;
  const params = excludeId
    ? [cum, consecutivoCum ?? null, excludeId]
    : [cum, consecutivoCum ?? null];
  const rows = await query(
    `SELECT codigo_control FROM productos
     WHERE cum = ? AND consecutivo_cum <=> ?
     ${excludeId ? 'AND id_producto != ?' : ''}
     LIMIT 1`,
    params
  );
  return rows[0]?.codigo_control ?? null;
}

export async function getNextControlCode(sku, idLaboratorio, cum, consecutivoCum) {
  if (!sku) return { codigo_control: null, duplicate_cum: null };

  // Formato: {sku}-{id_laboratorio}.{consecutivo_cum}
  // El id_laboratorio es el ID real del lab en BD — no un contador secuencial
  const labPart = idLaboratorio != null ? idLaboratorio : '0';
  const lastCum = extractLastCumPart(consecutivoCum);
  const cumSuffix = lastCum ? `.${lastCum}` : '';
  const codigo_control = `${sku}-${labPart}${cumSuffix}`;

  const duplicate_cum = await checkCumDuplicate(cum, consecutivoCum);

  return { codigo_control, duplicate_cum };
}

// tipo_producto se gestiona desde Parámetros (grupo 'tipo_producto'), igual
// que los tipos de movimiento de inventario — no es un enum fijo en código.
// Antes sí lo era (z.enum([...6 valores...])) y cuando alguien agregó
// "REACTIVO DIAGNOSTICO" por Parámetros, guardar o editar cualquier
// producto con ese tipo quedó bloqueado para siempre con "Invalid enum
// value", el mismo bug que ya se corrigió para movimientos_inventario.tipo.
async function assertTipoProductoValido(tipoProducto) {
  if (!tipoProducto) return;
  const rows = await query(
    `SELECT valor FROM parametros_sistema WHERE grupo = 'tipo_producto' AND activo = 1`
  );
  const validos = new Set(rows.map((r) => String(r.valor).toLowerCase()));
  if (!validos.has(String(tipoProducto).toLowerCase())) {
    throw new HttpError(400, `Tipo de producto "${tipoProducto}" no es válido.`);
  }
}

export async function createProduct(payload, userId = null) {
  await assertTipoProductoValido(payload.tipo_producto);

  // Duplicado: mismo CUM completo (cum + consecutivo_cum) — el identificador
  // real que asigna INVIMA. Ver checkCumDuplicate.
  if (payload.cum != null) {
    const dupCum = await checkCumDuplicate(payload.cum, payload.consecutivo_cum);
    if (dupCum) {
      await saveTrace({
        proceso: 'maestro_mx', subproceso: 'cum_duplicado_bloqueado', estado: 'cancelado',
        idUsuario: userId, referenciaTipo: 'producto',
        descripcion: `Intento bloqueado: CUM ${payload.cum}-${payload.consecutivo_cum ?? ''} ya registrado en ${dupCum}`,
        payload: { cum: payload.cum, consecutivo_cum: payload.consecutivo_cum, codigo_control_existente: dupCum, sku: payload.sku }
      });
      throw new HttpError(
        409,
        `Ya existe "${dupCum}" con el mismo CUM "${payload.cum}${payload.consecutivo_cum != null ? `-${payload.consecutivo_cum}` : ''}". No se puede crear un duplicado.`
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

  await assertTipoProductoValido(merged.tipo_producto);

  // Duplicado: mismo CUM completo (cum + consecutivo_cum), excluyendo el propio producto
  if (merged.cum != null) {
    const dupCum = await checkCumDuplicate(merged.cum, merged.consecutivo_cum, id);
    if (dupCum) {
      await saveTrace({
        proceso: 'maestro_mx', subproceso: 'cum_duplicado_bloqueado', estado: 'cancelado',
        idUsuario: userId, referenciaTipo: 'producto', referenciaId: id,
        descripcion: `Edición bloqueada: CUM ${merged.cum}-${merged.consecutivo_cum ?? ''} ya registrado en ${dupCum}`,
        payload: { id_producto: id, cum: merged.cum, consecutivo_cum: merged.consecutivo_cum, codigo_control_existente: dupCum }
      });
      throw new HttpError(
        409,
        `Ya existe "${dupCum}" con el mismo CUM "${merged.cum}${merged.consecutivo_cum != null ? `-${merged.consecutivo_cum}` : ''}". No se puede crear un duplicado.`
      );
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
