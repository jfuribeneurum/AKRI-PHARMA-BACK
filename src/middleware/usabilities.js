function userUsabilitySet(req) {
  const items = Array.isArray(req.user?.usabilities) ? req.user.usabilities : [];
  return new Set(items.map((item) => item?.clave).filter(Boolean));
}

function isAdmin(req) {
  return req.user?.role === 'ADMINISTRADOR';
}

function forbidden(res, missing = []) {
  return res.status(403).json({
    success: false,
    message: 'No autorizado para esta operación',
    missing
  });
}

export function requireAllUsabilities(...required) {
  const normalized = required.filter(Boolean);
  return (req, res, next) => {
    if (isAdmin(req) || normalized.length === 0) {
      return next();
    }
    const granted = userUsabilitySet(req);
    const missing = normalized.filter((key) => !granted.has(key));
    if (missing.length > 0) {
      return forbidden(res, missing);
    }
    return next();
  };
}

export function requireAnyUsability(...allowed) {
  const normalized = allowed.filter(Boolean);
  return (req, res, next) => {
    if (isAdmin(req) || normalized.length === 0) {
      return next();
    }
    const granted = userUsabilitySet(req);
    if (!normalized.some((key) => granted.has(key))) {
      return forbidden(res, normalized);
    }
    return next();
  };
}

export function hasUsability(user, key) {
  if (!user || !key) {
    return false;
  }
  if (user.role === 'ADMINISTRADOR') {
    return true;
  }
  return Array.isArray(user.usabilities) && user.usabilities.some((item) => item?.clave === key);
}
