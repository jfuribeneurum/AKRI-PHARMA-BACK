export function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: 'No autorizado para esta operación'
      });
    }
    return next();
  };
}
