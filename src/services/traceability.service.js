import { query } from '../config/db.js';
import { incrementProcessTraceWrites } from './metrics.service.js';

function executor(connectionOrPool) {
  if (!connectionOrPool) return { execute: async (sql, params) => query(sql, params) };
  if (connectionOrPool?.execute) return connectionOrPool;
  if (connectionOrPool?.pool?.execute) return connectionOrPool.pool;
  if (typeof connectionOrPool === 'function') return { execute: async (sql, params) => connectionOrPool(sql, params) };
  return null;
}

export async function recordProcessTrace(connectionOrPool, entry = {}) {
  try {
    const exec = executor(connectionOrPool);
    if (!exec?.execute) return;
    await exec.execute(
      `INSERT INTO procesos_terminados_trazabilidad (
        request_id, fecha_hora, proceso, subproceso, estado, id_sede, id_usuario, perfil_nombre,
        referencia_tipo, referencia_id, descripcion, endpoint, http_method, http_status,
        duracion_ms, session_hash, payload_json
      ) VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.request_id ?? null,
        entry.proceso ?? 'GENERAL',
        entry.subproceso ?? null,
        entry.estado ?? 'terminado',
        entry.id_sede ?? null,
        entry.id_usuario ?? null,
        entry.perfil_nombre ?? null,
        entry.referencia_tipo ?? null,
        entry.referencia_id ?? null,
        entry.descripcion ?? null,
        entry.endpoint ?? null,
        entry.http_method ?? null,
        entry.http_status ?? null,
        entry.duracion_ms ?? null,
        entry.session_hash ?? null,
        entry.payload_json ? JSON.stringify(entry.payload_json) : null
      ]
    );
    incrementProcessTraceWrites();
  } catch {
  }
}

export async function listAuditLog(filter = {}) {
  const limit = Math.max(1, Math.min(Number(filter.limit ?? 100), 500));
  const params = [];
  let sql = `SELECT
      a.id_log AS id_auditoria,
      a.fecha_hora,
      a.id_usuario,
      u.nombre_completo AS usuario,
      a.perfil_nombre,
      a.id_sede,
      s.nombre AS sede,
      a.modulo,
      a.submodulo,
      a.tabla_afectada,
      a.id_registro,
      a.accion,
      a.descripcion,
      a.resultado,
      a.datos_anteriores,
      a.datos_nuevos,
      a.campos_modificados,
      a.metadata,
      a.mensaje_error,
      a.request_id,
      a.endpoint,
      a.http_method,
      a.http_status,
      a.severidad,
      a.duracion_ms
    FROM log_auditoria a
    LEFT JOIN sedes s ON s.id_sede = a.id_sede
    LEFT JOIN usuarios u ON u.id_usuario = a.id_usuario
    WHERE 1 = 1`;
  if (filter.id_sede)   { sql += ' AND a.id_sede = ?';   params.push(Number(filter.id_sede)); }
  if (filter.id_usuario){ sql += ' AND a.id_usuario = ?'; params.push(Number(filter.id_usuario)); }
  if (filter.modulo)    { sql += ' AND a.modulo = ?';    params.push(String(filter.modulo)); }
  if (filter.accion)    { sql += ' AND a.accion = ?';    params.push(String(filter.accion)); }
  if (filter.date_from) { sql += ' AND a.fecha_hora >= ?'; params.push(String(filter.date_from)); }
  if (filter.date_to)   { sql += ' AND a.fecha_hora <= ?'; params.push(String(filter.date_to)); }
  if (filter.search) {
    const wildcard = `%${String(filter.search)}%`;
    sql += ' AND (a.descripcion LIKE ? OR u.nombre_completo LIKE ? OR a.perfil_nombre LIKE ? OR a.endpoint LIKE ? OR a.request_id LIKE ?)';
    params.push(wildcard, wildcard, wildcard, wildcard, wildcard);
  }
  sql += ` ORDER BY a.fecha_hora DESC LIMIT ${limit}`;
  const rows = await query(sql, params);
  return rows.map((row) => ({
    ...row,
    datos_anteriores: row.datos_anteriores && typeof row.datos_anteriores === 'string' ? JSON.parse(row.datos_anteriores) : (row.datos_anteriores ?? null),
    datos_nuevos: row.datos_nuevos && typeof row.datos_nuevos === 'string' ? JSON.parse(row.datos_nuevos) : (row.datos_nuevos ?? null),
    campos_modificados: row.campos_modificados && typeof row.campos_modificados === 'string' ? JSON.parse(row.campos_modificados) : (row.campos_modificados ?? null),
    metadata: row.metadata && typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? null)
  }));
}

export async function listUserActivity(filter = {}) {
  const limit = Math.max(1, Math.min(Number(filter.limit ?? 50), 200));
  const params = [];
  let sql = `SELECT
      t.id_usuario,
      u.nombre_completo AS usuario,
      t.perfil_nombre,
      COUNT(*) AS total_acciones,
      SUM(CASE WHEN t.estado = 'terminado' THEN 1 ELSE 0 END) AS exitosas,
      SUM(CASE WHEN t.estado = 'error' THEN 1 ELSE 0 END) AS errores,
      SUM(CASE WHEN t.estado = 'parcial' THEN 1 ELSE 0 END) AS parciales,
      MAX(t.fecha_hora) AS ultima_accion,
      MIN(t.fecha_hora) AS primera_accion,
      ROUND(AVG(t.duracion_ms)) AS duracion_prom_ms,
      GROUP_CONCAT(DISTINCT t.proceso ORDER BY t.proceso SEPARATOR ', ') AS modulos_usados
    FROM procesos_terminados_trazabilidad t
    LEFT JOIN usuarios u ON u.id_usuario = t.id_usuario
    WHERE t.id_usuario IS NOT NULL`;
  if (filter.date_from) { sql += ' AND t.fecha_hora >= ?'; params.push(String(filter.date_from)); }
  if (filter.date_to)   { sql += ' AND t.fecha_hora <= ?'; params.push(String(filter.date_to)); }
  sql += ` GROUP BY t.id_usuario, u.nombre_completo, t.perfil_nombre ORDER BY total_acciones DESC LIMIT ${limit}`;
  return query(sql, params);
}

export async function listProcessTrace(filter = {}) {
  const limit = Math.max(1, Math.min(Number(filter.limit ?? 100), 500));
  const params = [];
  let sql = `SELECT
      t.id_traza,
      t.request_id,
      t.fecha_hora,
      t.proceso,
      t.subproceso,
      t.estado,
      t.id_sede,
      s.nombre AS sede,
      t.id_usuario,
      u.nombre_completo AS usuario,
      t.perfil_nombre,
      t.referencia_tipo,
      t.referencia_id,
      t.descripcion,
      t.endpoint,
      t.http_method,
      t.http_status,
      t.duracion_ms,
      t.session_hash,
      t.payload_json
    FROM procesos_terminados_trazabilidad t
    LEFT JOIN sedes s ON s.id_sede = t.id_sede
    LEFT JOIN usuarios u ON u.id_usuario = t.id_usuario
    WHERE 1 = 1`;
  if (filter.id_sede) { sql += ' AND t.id_sede = ?'; params.push(Number(filter.id_sede)); }
  if (filter.id_usuario) { sql += ' AND t.id_usuario = ?'; params.push(Number(filter.id_usuario)); }
  if (filter.proceso) { sql += ' AND t.proceso = ?'; params.push(String(filter.proceso)); }
  if (filter.subproceso) { sql += ' AND t.subproceso = ?'; params.push(String(filter.subproceso)); }
  if (filter.date_from) { sql += ' AND t.fecha_hora >= ?'; params.push(String(filter.date_from)); }
  if (filter.date_to) { sql += ' AND t.fecha_hora <= ?'; params.push(String(filter.date_to)); }
  if (filter.search) {
    const wildcard = `%${String(filter.search)}%`;
    sql += ' AND (t.descripcion LIKE ? OR u.nombre_completo LIKE ? OR t.perfil_nombre LIKE ? OR t.referencia_tipo LIKE ? OR t.endpoint LIKE ? OR t.request_id LIKE ? OR t.subproceso LIKE ?)';
    params.push(wildcard, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard);
  }
  sql += ` ORDER BY t.fecha_hora DESC LIMIT ${limit}`;
  const rows = await query(sql, params);
  return rows.map((row) => ({
    ...row,
    payload_json: row.payload_json && typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : (row.payload_json ?? null)
  }));
}
