import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// Roles limitados a ciertos módulos: solo pueden llamar a estas APIs (prefijos
// relativos a /api). Un rol que no está aquí (ej. ADMINISTRADOR) no se limita.
// Debe mantenerse alineado con ROLE_ALLOWED_PATHS en el frontend
// (src/app/core/role-scope.ts).
export const ROLE_API_SCOPES = {
  INFORMES: ['/auth', '/reports', '/parametros/contrato/activos']
};

// Excepciones dentro del alcance permitido: prefijos que el rol no puede usar
// aunque caigan bajo uno de sus ROLE_API_SCOPES. Alineado con
// ROLE_HIDDEN_REPORTS en el frontend.
export const ROLE_API_DENY = {
  INFORMES: ['/reports/dispensing']
};

// Formatos (?format=) que un rol puede pedir en ciertos exports. Alineado con
// ROLE_REPORT_FORMATS en el frontend.
export const ROLE_API_FORMATS = {
  INFORMES: { '/reports/rips-am': ['csv'] }
};

export function isFormatAllowed(role, path, format) {
  const reglas = ROLE_API_FORMATS[role];
  if (!reglas) return true;
  const prefix = Object.keys(reglas).find((p) => matchesPrefix(path, p));
  if (!prefix) return true;
  return reglas[prefix].includes(String(format ?? '').toLowerCase());
}

const matchesPrefix =(path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

export function isApiPathAllowed(role, path) {
  const scopes = ROLE_API_SCOPES[role];
  if (!scopes) return true;
  if ((ROLE_API_DENY[role] ?? []).some((prefix) => matchesPrefix(path, prefix))) return false;
  return scopes.some((prefix) => matchesPrefix(path, prefix));
}

// Se monta a nivel de app (antes de los routers), así que decodifica el token
// por su cuenta. Sin token o con token inválido deja pasar: el authRequired de
// cada router responde el 401 correspondiente.
export function roleScope(req, res, next) {
  const [, token] = (req.headers.authorization ?? '').split(' ');
  if (!token) return next();

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    return next();
  }

  if (!isApiPathAllowed(payload?.role, req.path)) {
    return res.status(403).json({
      success: false,
      message: 'Tu perfil no tiene acceso a esta información.'
    });
  }
  if (isFormatAllowed(payload?.role, req.path, req.query?.format)) return next();
  return res.status(403).json({
    success: false,
    message: 'Tu perfil solo puede descargar este informe en CSV.'
  });
}
