import { query as defaultQuery } from '../config/db.js';

function safeStringify(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return null;
  }
}

function resolveExecutor(connectionOrPool) {
  if (!connectionOrPool) {
    return {
      execute: async (sql, params) => defaultQuery(sql, params)
    };
  }
  if (typeof connectionOrPool === 'function') {
    return {
      execute: async (sql, params) => connectionOrPool(sql, params)
    };
  }
  if (typeof connectionOrPool.execute === 'function') {
    return connectionOrPool;
  }
  if (typeof connectionOrPool.query === 'function') {
    return {
      execute: async (sql, params) => connectionOrPool.query(sql, params)
    };
  }
  if (connectionOrPool.pool && typeof connectionOrPool.pool.execute === 'function') {
    return connectionOrPool.pool;
  }
  return null;
}

export function buildAuditFromUser(user = {}, overrides = {}) {
  return {
    idUsuario: user?.sub ?? user?.id ?? overrides.idUsuario ?? null,
    perfilNombre: user?.role ?? overrides.perfilNombre ?? null,
    idSede: user?.id_sede ?? overrides.idSede ?? null,
    modulo: overrides.modulo ?? 'GENERAL',
    submodulo: overrides.submodulo ?? null,
    tablaAfectada: overrides.tablaAfectada ?? null,
    idRegistro: overrides.idRegistro ?? null,
    accion: overrides.accion ?? 'OTRO',
    descripcion: overrides.descripcion ?? null,
    resultado: overrides.resultado ?? 'exitoso',
    datosAnteriores: overrides.datosAnteriores ?? null,
    datosNuevos: overrides.datosNuevos ?? null,
    camposModificados: overrides.camposModificados ?? null,
    metadata: overrides.metadata ?? null,
    mensajeError: overrides.mensajeError ?? null,
    requestId: overrides.requestId ?? null,
    endpoint: overrides.endpoint ?? null,
    httpMethod: overrides.httpMethod ?? null,
    httpStatus: overrides.httpStatus ?? null,
    severidad: overrides.severidad ?? 'info',
    sessionHash: overrides.sessionHash ?? null,
    duracionMs: overrides.duracionMs ?? null
  };
}

export async function writeAudit(connectionOrPool, entry) {
  try {
    const executor = resolveExecutor(connectionOrPool);
    if (!executor?.execute) return;
    await executor.execute(
      `INSERT INTO log_auditoria
       (id_usuario, perfil_nombre, id_sede, modulo, submodulo, tabla_afectada, id_registro,
        accion, descripcion, resultado, datos_anteriores, datos_nuevos, campos_modificados,
        metadata, mensaje_error, request_id, endpoint, http_method, http_status, severidad,
        session_hash, duracion_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.idUsuario ?? null,
        entry.perfilNombre ?? null,
        entry.idSede ?? null,
        entry.modulo ?? 'GENERAL',
        entry.submodulo ?? null,
        entry.tablaAfectada ?? null,
        entry.idRegistro ?? null,
        entry.accion ?? 'OTRO',
        entry.descripcion ?? null,
        entry.resultado ?? 'exitoso',
        safeStringify(entry.datosAnteriores),
        safeStringify(entry.datosNuevos),
        safeStringify(entry.camposModificados),
        safeStringify(entry.metadata),
        entry.mensajeError ?? null,
        entry.requestId ?? null,
        entry.endpoint ?? null,
        entry.httpMethod ?? null,
        entry.httpStatus ?? null,
        entry.severidad ?? 'info',
        entry.sessionHash ?? null,
        entry.duracionMs ?? null
      ]
    );
  } catch (_error) {
  }
}
