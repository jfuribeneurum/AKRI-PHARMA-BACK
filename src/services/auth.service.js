import jwt from 'jsonwebtoken';
import { query } from '../config/db.js';
import { env } from '../config/env.js';
import { verifyPassword } from '../utils/password.js';
import { HttpError } from '../utils/http-error.js';
import { ensureRuntimeSchema } from './runtime-schema.service.js';

function isMissingTableError(error) {
  return error?.code === 'ER_NO_SUCH_TABLE' || error?.errno === 1146;
}

function safeParseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  if (typeof value === 'object') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

async function getBaseUserByUsername(username) {
  const rows = await query(
    `SELECT
        u.id_usuario,
        u.username,
        u.password_hash,
        u.nombre_completo,
        u.email,
        u.es_activo,
        u.id_rol,
        u.id_sede,
        u.id_almacen_principal,
        r.nombre AS role,
        r.descripcion AS role_description,
        r.perm_inventario_consulta,
        r.perm_inventario_movimiento,
        r.perm_inventario_ajuste,
        r.perm_compras_solicitar,
        r.perm_compras_aprobar,
        r.perm_compras_recibir,
        r.perm_ventas_dispensar,
        r.perm_ventas_facturar,
        r.perm_ventas_devolucion,
        r.perm_controlados_dispensar,
        r.perm_controlados_libro,
        r.perm_cadena_frio_consulta,
        r.perm_cadena_frio_registro,
        r.perm_cadena_frio_aprobar_excursion,
        r.perm_farmacovigilancia,
        r.perm_reportes_operativos,
        r.perm_reportes_financieros,
        r.perm_configuracion,
        r.perm_usuarios_gestionar,
        r.perm_auditoria_consulta,
        r.perm_destruccion_autorizar,
        r.permisos_extra
      FROM usuarios u
      INNER JOIN roles r ON r.id_rol = u.id_rol
      WHERE u.username = ?
      LIMIT 1`,
    [username]
  );

  return rows[0] ?? null;
}

async function getBaseUserById(idUsuario) {
  const rows = await query(
    `SELECT
        u.id_usuario,
        u.username,
        u.password_hash,
        u.nombre_completo,
        u.email,
        u.es_activo,
        u.id_rol,
        u.id_sede,
        u.id_almacen_principal,
        r.nombre AS role,
        r.descripcion AS role_description,
        r.perm_inventario_consulta,
        r.perm_inventario_movimiento,
        r.perm_inventario_ajuste,
        r.perm_compras_solicitar,
        r.perm_compras_aprobar,
        r.perm_compras_recibir,
        r.perm_ventas_dispensar,
        r.perm_ventas_facturar,
        r.perm_ventas_devolucion,
        r.perm_controlados_dispensar,
        r.perm_controlados_libro,
        r.perm_cadena_frio_consulta,
        r.perm_cadena_frio_registro,
        r.perm_cadena_frio_aprobar_excursion,
        r.perm_farmacovigilancia,
        r.perm_reportes_operativos,
        r.perm_reportes_financieros,
        r.perm_configuracion,
        r.perm_usuarios_gestionar,
        r.perm_auditoria_consulta,
        r.perm_destruccion_autorizar,
        r.permisos_extra
      FROM usuarios u
      INNER JOIN roles r ON r.id_rol = u.id_rol
      WHERE u.id_usuario = ?
      LIMIT 1`,
    [idUsuario]
  );

  return rows[0] ?? null;
}

async function getUserAccess(idUsuario) {
  return query(
    `SELECT us.id_sede, us.es_predeterminada, us.puede_admin_sede, s.codigo, s.nombre, s.es_principal, s.activo
     FROM usuarios_sedes us
     INNER JOIN sedes s ON s.id_sede = us.id_sede
     WHERE us.id_usuario = ?
       AND s.activo = TRUE
     ORDER BY us.es_predeterminada DESC, s.es_principal DESC, s.nombre ASC`,
    [idUsuario]
  );
}

async function getRoleUsabilities(idRol) {
  let rows = [];
  try {
    rows = await query(
      `SELECT clave, categoria, habilitado, metadata
       FROM role_usabilities
       WHERE id_rol = ? AND habilitado = TRUE
       ORDER BY categoria ASC, clave ASC`,
      [idRol]
    );
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
    await ensureRuntimeSchema({ force: true });
    rows = await query(
      `SELECT clave, categoria, habilitado, metadata
       FROM role_usabilities
       WHERE id_rol = ? AND habilitado = TRUE
       ORDER BY categoria ASC, clave ASC`,
      [idRol]
    );
  }

  return rows.map((row) => ({
    clave: row.clave,
    categoria: row.categoria,
    metadata: safeParseJson(row.metadata, {})
  }));
}

async function getSiteSummary(idSede, idAlmacenPrincipal) {
  if (!idSede) {
    return { sede_nombre: null, sede_codigo: null, es_principal: false, almacen_nombre: null, id_almacen_principal: null };
  }

  const rows = await query(
    `SELECT
        s.nombre AS sede_nombre,
        s.codigo AS sede_codigo,
        s.es_principal,
        a.id_almacen AS id_almacen_principal,
        a.nombre AS almacen_nombre
     FROM sedes s
     LEFT JOIN almacenes a
       ON a.id_sede = s.id_sede
      AND a.activo = TRUE
      AND (
            a.id_almacen = ? OR
            a.es_principal = TRUE OR
            a.tipo = 'general'
          )
     WHERE s.id_sede = ?
     ORDER BY (a.id_almacen = ?) DESC, a.es_principal DESC, a.nombre ASC
     LIMIT 1`,
    [idAlmacenPrincipal ?? null, idSede, idAlmacenPrincipal ?? null]
  );

  return rows[0] ?? { sede_nombre: null, sede_codigo: null, es_principal: false, almacen_nombre: null, id_almacen_principal: null };
}

function resolveActiveSite(access = [], currentSiteId = null, requestedSiteId = null) {
  const numericRequested = requestedSiteId ? Number(requestedSiteId) : null;
  const authorized = new Set(access.map((row) => Number(row.id_sede)));
  if (numericRequested && authorized.has(numericRequested)) {
    return numericRequested;
  }
  const numericCurrent = currentSiteId ? Number(currentSiteId) : null;
  if (numericCurrent && authorized.has(numericCurrent)) {
    return numericCurrent;
  }
  const preferred = access.find((row) => Number(row.es_predeterminada) === 1 || row.es_predeterminada === true);
  return Number(preferred?.id_sede ?? access[0]?.id_sede ?? numericCurrent ?? null);
}

async function getSedeAlmacenes(idSede) {
  if (!idSede) return [];
  return query(
    `SELECT id_almacen, codigo, nombre, tipo, es_principal
       FROM almacenes
      WHERE id_sede = ? AND activo = TRUE
      ORDER BY es_principal DESC, nombre ASC`,
    [idSede]
  );
}

function resolveActiveAlmacen(almacenes = [], currentAlmacenId = null, requestedAlmacenId = null) {
  const authorized = new Set(almacenes.map((row) => Number(row.id_almacen)));
  const numericRequested = requestedAlmacenId ? Number(requestedAlmacenId) : null;
  if (numericRequested && authorized.has(numericRequested)) {
    return numericRequested;
  }
  const numericCurrent = currentAlmacenId ? Number(currentAlmacenId) : null;
  if (numericCurrent && authorized.has(numericCurrent)) {
    return numericCurrent;
  }
  const preferred = almacenes.find((row) => Number(row.es_principal) === 1 || row.es_principal === true);
  return Number(preferred?.id_almacen ?? almacenes[0]?.id_almacen ?? numericCurrent ?? null) || null;
}

async function syncUserCurrentSite(user, activeSiteId) {
  if (!activeSiteId) {
    return user;
  }

  const siteSummary = await getSiteSummary(activeSiteId, user.id_almacen_principal);
  const targetWarehouseId = siteSummary.id_almacen_principal ?? user.id_almacen_principal ?? null;

  await query(
    `UPDATE usuarios
        SET id_sede = ?,
            id_almacen_principal = COALESCE(?, id_almacen_principal)
      WHERE id_usuario = ?`,
    [activeSiteId, targetWarehouseId, user.id_usuario]
  );

  return {
    ...user,
    id_sede: activeSiteId,
    id_almacen_principal: targetWarehouseId
  };
}

function buildPermissions(user) {
  return {
    perm_inventario_consulta: Boolean(user.perm_inventario_consulta),
    perm_inventario_movimiento: Boolean(user.perm_inventario_movimiento),
    perm_inventario_ajuste: Boolean(user.perm_inventario_ajuste),
    perm_compras_solicitar: Boolean(user.perm_compras_solicitar),
    perm_compras_aprobar: Boolean(user.perm_compras_aprobar),
    perm_compras_recibir: Boolean(user.perm_compras_recibir),
    perm_ventas_dispensar: Boolean(user.perm_ventas_dispensar),
    perm_ventas_facturar: Boolean(user.perm_ventas_facturar),
    perm_ventas_devolucion: Boolean(user.perm_ventas_devolucion),
    perm_controlados_dispensar: Boolean(user.perm_controlados_dispensar),
    perm_controlados_libro: Boolean(user.perm_controlados_libro),
    perm_cadena_frio_consulta: Boolean(user.perm_cadena_frio_consulta),
    perm_cadena_frio_registro: Boolean(user.perm_cadena_frio_registro),
    perm_cadena_frio_aprobar_excursion: Boolean(user.perm_cadena_frio_aprobar_excursion),
    perm_farmacovigilancia: Boolean(user.perm_farmacovigilancia),
    perm_reportes_operativos: Boolean(user.perm_reportes_operativos),
    perm_reportes_financieros: Boolean(user.perm_reportes_financieros),
    perm_configuracion: Boolean(user.perm_configuracion),
    perm_usuarios_gestionar: Boolean(user.perm_usuarios_gestionar),
    perm_auditoria_consulta: Boolean(user.perm_auditoria_consulta),
    perm_destruccion_autorizar: Boolean(user.perm_destruccion_autorizar),
    permisos_extra: safeParseJson(user.permisos_extra, {})
  };
}

function issueToken({ user, usabilities, siteSummary }) {
  return jwt.sign(
    {
      sub: user.id_usuario,
      username: user.username,
      role: user.role,
      id_rol: user.id_rol,
      id_sede: user.id_sede,
      sede: siteSummary.sede_nombre,
      sede_codigo: siteSummary.sede_codigo,
      sede_es_principal: Boolean(siteSummary.es_principal),
      id_almacen: user.id_almacen_principal ?? null,
      name: user.nombre_completo,
      usabilities
    },
    env.JWT_SECRET,
    {
      expiresIn: env.JWT_EXPIRES_IN
    }
  );
}

async function buildAuthResponse(user, requestedSiteId = null) {
  const access = await getUserAccess(user.id_usuario);
  if (!access.length) {
    throw new HttpError(403, 'El usuario no tiene sedes autorizadas');
  }

  const activeSiteId = resolveActiveSite(access, user.id_sede, requestedSiteId);
  if (!activeSiteId) {
    throw new HttpError(403, 'No fue posible determinar la sede activa de la sesión');
  }

  const isAuthorized = access.some((item) => Number(item.id_sede) === Number(activeSiteId));
  if (!isAuthorized) {
    throw new HttpError(403, 'La sede seleccionada no está autorizada para este usuario');
  }

  const refreshedUser = await syncUserCurrentSite(user, activeSiteId);
  const siteSummary = await getSiteSummary(activeSiteId, refreshedUser.id_almacen_principal);
  const almacenes = await getSedeAlmacenes(activeSiteId);
  const usabilities = await getRoleUsabilities(refreshedUser.id_rol);
  const permissions = buildPermissions(refreshedUser);
  const token = issueToken({ user: refreshedUser, usabilities, siteSummary });

  return {
    token,
    site_selection_required: access.length > 1,
    user: {
      id: refreshedUser.id_usuario,
      username: refreshedUser.username,
      name: refreshedUser.nombre_completo,
      email: refreshedUser.email,
      role: refreshedUser.role,
      role_description: refreshedUser.role_description,
      id_rol: refreshedUser.id_rol,
      id_sede: refreshedUser.id_sede,
      sede: siteSummary.sede_nombre,
      sede_codigo: siteSummary.sede_codigo,
      sede_es_principal: Boolean(siteSummary.es_principal),
      id_almacen_principal: siteSummary.id_almacen_principal ?? refreshedUser.id_almacen_principal,
      almacen_principal: siteSummary.almacen_nombre,
      almacenes,
      almacen_selection_required: almacenes.length > 1,
      access,
      permissions,
      usabilities
    }
  };
}

export async function login({ username, password, id_sede = null }) {
  const user = await getBaseUserByUsername(username);

  if (!user || !user.es_activo || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'Credenciales inválidas');
  }

  const response = await buildAuthResponse(user, id_sede);

  await query(
    'UPDATE usuarios SET ultimo_acceso = NOW(), intentos_fallidos = 0 WHERE id_usuario = ?',
    [user.id_usuario]
  );

  return response;
}

export async function selectSiteSession({ userId, id_sede }) {
  const user = await getBaseUserById(userId);
  if (!user || !user.es_activo) {
    throw new HttpError(404, 'Usuario no encontrado o inactivo');
  }
  if (!id_sede) {
    throw new HttpError(400, 'Debes seleccionar una sede');
  }
  return buildAuthResponse(user, id_sede);
}

export async function selectAlmacenSession({ userId, id_almacen }) {
  const user = await getBaseUserById(userId);
  if (!user || !user.es_activo) {
    throw new HttpError(404, 'Usuario no encontrado o inactivo');
  }
  if (!id_almacen) {
    throw new HttpError(400, 'Debes seleccionar un almacén');
  }

  const almacenes = await getSedeAlmacenes(user.id_sede);
  const isAuthorized = almacenes.some((a) => Number(a.id_almacen) === Number(id_almacen));
  if (!isAuthorized) {
    throw new HttpError(403, 'El almacén seleccionado no pertenece a la sede activa');
  }

  await query(
    `UPDATE usuarios SET id_almacen_principal = ? WHERE id_usuario = ?`,
    [id_almacen, userId]
  );

  return buildAuthResponse({ ...user, id_almacen_principal: id_almacen }, user.id_sede);
}

export { getSedeAlmacenes };
