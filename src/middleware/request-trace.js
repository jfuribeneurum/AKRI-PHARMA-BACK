import crypto from 'node:crypto';

import { env } from '../config/env.js';
import { buildAuditFromUser, writeAudit } from '../services/audit.service.js';
import { markRequestStart, recordHttpRequest, incrementAuditWrites } from '../services/metrics.service.js';
import { recordProcessTrace } from '../services/traceability.service.js';

function classifyAction(req) {
  if (req.path.includes('/login')) return 'LOGIN';
  if (req.method === 'POST') return 'INSERT';
  if (req.method === 'PUT' || req.method === 'PATCH') return 'UPDATE';
  if (req.method === 'DELETE') return 'DELETE';
  return 'SELECT';
}

function splitModule(req) {
  const parts = req.path.split('/').filter(Boolean);
  const apiIndex = parts.indexOf('api');
  const moduleName = apiIndex >= 0 ? parts[apiIndex + 1] : parts[0];
  const submoduleName = apiIndex >= 0 ? parts[apiIndex + 2] : parts[1];
  return {
    modulo: (moduleName ?? 'general').toUpperCase(),
    submodulo: submoduleName ? String(submoduleName).toUpperCase() : null
  };
}

function shouldTrace(req) {
  if (!env.REQUEST_TRACE_ENABLED) return false;
  return !env.REQUEST_TRACE_EXCLUDE_PATHS.includes(req.path);
}

function sessionHash(req) {
  const auth = req.headers.authorization ?? '';
  if (!auth) return null;
  return crypto.createHash('sha256').update(auth).digest('hex');
}

export function requestTraceMiddleware(req, res, next) {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);

  if (!shouldTrace(req)) {
    return next();
  }

  const startedAt = Date.now();
  markRequestStart();

  res.on('finish', async () => {
    const durationMs = Date.now() - startedAt;
    const { modulo, submodulo } = splitModule(req);
    const action = classifyAction(req);
    const statusCode = res.statusCode;
    const result = statusCode >= 500 ? 'fallido' : (statusCode >= 400 ? 'parcial' : 'exitoso');
    const severity = statusCode >= 500 ? 'critical' : (statusCode >= 400 ? 'warning' : 'info');
    const route = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : req.path;

    recordHttpRequest({ method: req.method, route, statusCode, durationMs });

    await writeAudit(undefined, buildAuditFromUser(req.user, {
      modulo,
      submodulo,
      accion: action,
      descripcion: `${req.method} ${req.originalUrl}`,
      resultado: result,
      metadata: {
        request_id: req.requestId,
        route,
        query: req.query,
        body_keys: Object.keys(req.body ?? {}),
        params: req.params,
        authenticated: Boolean(req.user?.sub)
      },
      requestId: req.requestId,
      endpoint: req.originalUrl,
      httpMethod: req.method,
      httpStatus: statusCode,
      severidad: severity,
      sessionHash: sessionHash(req),
      duracionMs: durationMs,
      mensajeError: result !== 'exitoso' ? `HTTP ${statusCode}` : null
    }));
    incrementAuditWrites();

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.includes('/login')) {
      await recordProcessTrace(undefined, {
        request_id: req.requestId,
        proceso: modulo,
        subproceso: submodulo,
        estado: statusCode >= 500 ? 'error' : (statusCode >= 400 ? 'parcial' : 'terminado'),
        id_sede: req.user?.id_sede ?? null,
        id_usuario: req.user?.sub ?? null,
        perfil_nombre: req.user?.role ?? null,
        referencia_tipo: req.body?.referencia_tipo ?? req.query?.referencia_tipo ?? null,
        referencia_id: req.body?.referencia_id ?? req.query?.referencia_id ?? null,
        descripcion: `${req.method} ${req.originalUrl}`,
        endpoint: req.originalUrl,
        http_method: req.method,
        http_status: statusCode,
        duracion_ms: durationMs,
        session_hash: sessionHash(req),
        payload_json: {
          params: req.params,
          body_keys: Object.keys(req.body ?? {})
        }
      });
    }
  });

  next();
}
