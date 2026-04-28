import { query } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';

const BUILTIN_CATALOG = [
  { key: 'keyboard_wedge', nombre: 'Keyboard wedge', tipo_scanner: 'generic_wedge', forma_uso: 'desconocida', descripcion: 'Lector que emula teclado; útil para lápiz, ranura, CCD, imagen o láser cuando el SO lo entrega como teclado.' },
  { key: 'webhid', nombre: 'WebHID', tipo_scanner: 'desconocido', forma_uso: 'desconocida', descripcion: 'Canal HID con permiso del navegador.' },
  { key: 'webserial', nombre: 'Web Serial', tipo_scanner: 'desconocido', forma_uso: 'desconocida', descripcion: 'Canal serial para lectores RS232/USB-serial o wearables.' },
  { key: 'webusb', nombre: 'WebUSB', tipo_scanner: 'desconocido', forma_uso: 'desconocida', descripcion: 'Canal USB con vendor/product id disponibles.' },
  { key: 'camera', nombre: 'Cámara / scanner de imagen', tipo_scanner: 'imagen', forma_uso: 'portatil', descripcion: 'Lectura por cámara del dispositivo usando BarcodeDetector cuando esté disponible.' },
  { key: 'image_upload', nombre: 'Imagen importada', tipo_scanner: 'imagen', forma_uso: 'mesa', descripcion: 'Lectura desde imagen escaneada o foto importada.' }
];

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export async function listScannerCatalog() {
  return BUILTIN_CATALOG;
}

export async function listScannerProfiles(siteId = null) {
  const params = [];
  let sql = `SELECT sp.*, s.nombre AS sede_nombre, u.nombre_completo AS creado_por_nombre
             FROM scanner_profiles sp
             INNER JOIN sedes s ON s.id_sede = sp.id_sede
             LEFT JOIN usuarios u ON u.id_usuario = sp.creado_por`;
  if (siteId) {
    sql += ' WHERE sp.id_sede = ?';
    params.push(siteId);
  }
  sql += ' ORDER BY s.nombre ASC, sp.nombre ASC';
  const rows = await query(sql, params);
  return rows.map((row) => ({ ...row, metadata: parseJson(row.metadata, {}) }));
}

export async function createScannerProfile(payload, userId) {
  if (!payload.id_sede) throw new HttpError(400, 'La sede es obligatoria para registrar el lector');
  const result = await query(
    `INSERT INTO scanner_profiles (
      id_sede, nombre, canal_preferido, tipo_scanner, forma_uso,
      vendor_id, product_id, serial_number, patron_entrada, teclado_sufijo,
      activo, metadata, creado_por
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.id_sede,
      payload.nombre,
      payload.canal_preferido ?? 'keyboard_wedge',
      payload.tipo_scanner ?? 'desconocido',
      payload.forma_uso ?? 'desconocida',
      payload.vendor_id ?? null,
      payload.product_id ?? null,
      payload.serial_number ?? null,
      payload.patron_entrada ?? null,
      payload.teclado_sufijo ?? 'Enter',
      payload.activo !== false,
      payload.metadata ? JSON.stringify(payload.metadata) : null,
      userId ?? null
    ]
  );
  const rows = await query('SELECT * FROM scanner_profiles WHERE id_scanner_profile = ?', [result.insertId]);
  return { ...rows[0], metadata: parseJson(rows[0]?.metadata, {}) };
}

export async function updateScannerProfile(id, payload) {
  const rows = await query('SELECT * FROM scanner_profiles WHERE id_scanner_profile = ?', [id]);
  const current = rows[0];
  if (!current) throw new HttpError(404, 'Perfil de lector no encontrado');
  const merged = { ...current, ...payload };
  await query(
    `UPDATE scanner_profiles
     SET id_sede = ?, nombre = ?, canal_preferido = ?, tipo_scanner = ?, forma_uso = ?,
         vendor_id = ?, product_id = ?, serial_number = ?, patron_entrada = ?, teclado_sufijo = ?,
         activo = ?, metadata = ?
     WHERE id_scanner_profile = ?`,
    [
      merged.id_sede,
      merged.nombre,
      merged.canal_preferido,
      merged.tipo_scanner,
      merged.forma_uso,
      merged.vendor_id ?? null,
      merged.product_id ?? null,
      merged.serial_number ?? null,
      merged.patron_entrada ?? null,
      merged.teclado_sufijo ?? 'Enter',
      merged.activo !== false,
      merged.metadata ? JSON.stringify(merged.metadata) : current.metadata,
      id
    ]
  );
  const updated = await query('SELECT * FROM scanner_profiles WHERE id_scanner_profile = ?', [id]);
  return { ...updated[0], metadata: parseJson(updated[0]?.metadata, {}) };
}
