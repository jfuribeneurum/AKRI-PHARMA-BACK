import { query, withTransaction } from '../config/db.js';
import { hashPassword } from '../utils/password.js';
import { HttpError } from '../utils/http-error.js';
import { ensureRuntimeSchema } from './runtime-schema.service.js';
import { buildAuditFromUser, writeAudit } from './audit.service.js';
import { recordProcessTrace } from './traceability.service.js';

const USABILITY_CATALOG = [
  { clave: 'sites.manage', nombre: 'Gestor de sedes', descripcion: 'Crear, editar y administrar sedes desde dashboard / centro de control', categoria: 'multisede' },
  { clave: 'sites.delete', nombre: 'Eliminar sedes', descripcion: 'Desactivar o reactivar sedes y sus estructuras operativas', categoria: 'multisede' },
  { clave: 'profiles.manage', nombre: 'Gestor de perfiles', descripcion: 'Crear, editar y desactivar perfiles del sistema', categoria: 'seguridad' },
  { clave: 'profiles.assign', nombre: 'Adjudicar perfiles', descripcion: 'Asignar perfiles, sedes y privilegios a usuarios', categoria: 'seguridad' },
  { clave: 'users.manage', nombre: 'Gestor de usuarios', descripcion: 'Crear, editar, activar y desactivar usuarios', categoria: 'seguridad' },
  { clave: 'users.delete', nombre: 'Eliminar usuarios', descripcion: 'Desactivar usuarios y suspender su acceso', categoria: 'seguridad' },
  { clave: 'requests.branch.create', nombre: 'Solicitar items a central', descripcion: 'Permite solicitar abastecimiento desde sedes periféricas', categoria: 'compras' },
  { clave: 'requests.central.review', nombre: 'Revisar solicitudes de compra', descripcion: 'Permite a sede central revisar solicitudes provenientes de otras sedes', categoria: 'compras' },
  { clave: 'auth.site.switch', nombre: 'Cambiar sede activa', descripcion: 'Autoriza seleccionar la sede activa al iniciar sesión', categoria: 'seguridad' },
  { clave: 'dashboard.site.manager', nombre: 'Dashboard gestor multisede', descripcion: 'Muestra widgets operativos de sedes y perfiles en el dashboard', categoria: 'dashboard' },
  { clave: 'dashboard.control.center', nombre: 'Centro de control', descripcion: 'Habilita el centro de control operativo integrado al dashboard', categoria: 'dashboard' },
  { clave: 'inventory.local_general', nombre: 'Inventario local y general', descripcion: 'Vista local por sede y consolidado general', categoria: 'inventario' },
  { clave: 'dispensing.requests.manual', nombre: 'Solicitudes manuales', descripcion: 'Crear solicitudes manuales item por item', categoria: 'dispensacion' },
  { clave: 'dispensing.requests.ehr', nombre: 'Importación HCE', descripcion: 'Crear solicitudes desde payload clínico / API HCE', categoria: 'dispensacion' },
  { clave: 'dispensing.requests.prescription_scan', nombre: 'Fórmula escaneada', descripcion: 'Crear solicitudes desde fórmula escaneada', categoria: 'dispensacion' },
  { clave: 'scanners.auto_detect', nombre: 'Auto detección de lectores', descripcion: 'Detectar canal disponible y registrar perfil físico', categoria: 'lectores' },
  { clave: 'traceability.process_finished', nombre: 'Trazabilidad de procesos', descripcion: 'Consultar quién terminó cada proceso', categoria: 'auditoria' }
];

const ROLE_PERMISSION_FIELDS = [
  'perm_inventario_consulta',
  'perm_inventario_movimiento',
  'perm_inventario_ajuste',
  'perm_compras_solicitar',
  'perm_compras_aprobar',
  'perm_compras_recibir',
  'perm_ventas_dispensar',
  'perm_ventas_facturar',
  'perm_ventas_devolucion',
  'perm_controlados_dispensar',
  'perm_controlados_libro',
  'perm_cadena_frio_consulta',
  'perm_cadena_frio_registro',
  'perm_cadena_frio_aprobar_excursion',
  'perm_farmacovigilancia',
  'perm_reportes_operativos',
  'perm_reportes_financieros',
  'perm_configuracion',
  'perm_usuarios_gestionar',
  'perm_auditoria_consulta',
  'perm_destruccion_autorizar'
];

function isMissingTableError(error) {
  return error?.code === 'ER_NO_SUCH_TABLE' || error?.errno === 1146;
}

function parseJson(value, fallback = null) {
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

function normalizeRolePayload(payload = {}) {
  const role = {
    nombre: String(payload.nombre ?? '').trim(),
    descripcion: payload.descripcion ?? null,
    nivel_jerarquia: Number(payload.nivel_jerarquia ?? 5),
    permisos_extra: payload.permisos_extra ?? null,
    es_activo: payload.es_activo !== false
  };

  for (const field of ROLE_PERMISSION_FIELDS) {
    role[field] = Boolean(payload[field]);
  }

  return role;
}



function actorMeta(actor = {}) {
  return {
    id_usuario: actor?.sub ?? actor?.id_usuario ?? actor?.id ?? actor?.creado_por ?? actor?.modificado_por ?? null,
    perfil_nombre: actor?.role ?? actor?.perfil_nombre ?? actor?.perfil ?? actor?.nombre_rol ?? null,
    id_sede: actor?.id_sede ?? actor?.sede_id ?? null,
    request_id: actor?.requestId ?? actor?.request_id ?? null,
    endpoint: actor?.endpoint ?? actor?.originalUrl ?? null,
    http_method: actor?.httpMethod ?? actor?.http_method ?? actor?.method ?? null,
    http_status: actor?.httpStatus ?? actor?.http_status ?? null,
    session_hash: actor?.sessionHash ?? actor?.session_hash ?? null
  };
}

function adminAuditMatchesScope(scope = 'all', row = {}) {
  const normalized = String(scope ?? 'all').trim().toLowerCase();
  if (!normalized || normalized === 'all') return true;
  const modulo = String(row.modulo ?? '').trim().toLowerCase();
  const submodulo = String(row.submodulo ?? '').trim().toLowerCase();
  const tabla = String(row.tabla_afectada ?? '').trim().toLowerCase();
  if (normalized === 'sites') return submodulo === 'sedes' || tabla === 'sedes';
  if (normalized === 'profiles') return submodulo.startsWith('perfil') || tabla === 'roles' || tabla === 'role_usabilities';
  if (normalized === 'users') return submodulo.startsWith('usuarios') || tabla === 'usuarios' || tabla === 'usuarios_sedes';
  if (normalized === 'requests') return submodulo.includes('solicitud') || tabla === 'solicitudes_compra_sedes' || tabla === 'solicitudes_compra_sedes_detalle';
  if (normalized === 'inventory') return modulo === 'inventario' || submodulo === 'inventario' || tabla.includes('inventario');
  if (normalized === 'traceability') return modulo === 'auditoria' || submodulo === 'trazabilidad' || tabla === 'log_auditoria';
  if (normalized === 'audit') return modulo === 'admin' || modulo === 'auditoria' || tabla === 'log_auditoria';
  if (normalized === 'permissions') return submodulo === 'perfiles_usabilidades' || tabla === 'role_usabilities';
  return submodulo === normalized || tabla === normalized || modulo === normalized;
}

function adminReferenceTable(referenceType = '', fallback = null) {
  const normalized = String(referenceType || '').trim().toUpperCase();
  if (normalized === 'SEDE') return 'sedes';
  if (normalized === 'PERFIL') return 'roles';
  if (normalized === 'USUARIO') return 'usuarios';
  if (normalized === 'SOLICITUD_COMPRA_SEDE') return 'solicitudes_compra_sedes';
  if (normalized === 'LECTOR') return 'scanner_profiles';
  return fallback;
}

function adminActionFromMode(mode = '') {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'create') return 'INSERT';
  if (normalized === 'update') return 'UPDATE';
  if (normalized === 'delete') return 'DELETE';
  return 'OTRO';
}

async function recordAdminTrace(connectionOrPool, actor, submodulo, descripcion, details = {}) {
  const info = actorMeta(actor);
  const payload = details.payload_json ?? {};
  const before = payload.before ?? details.before ?? null;
  const after = payload.after ?? details.after ?? null;
  const moduleName = String(details.modulo ?? 'ADMIN').toUpperCase();
  const idSede = details.id_sede ?? payload.id_sede ?? info.id_sede ?? null;

  await writeAudit(
    connectionOrPool,
    buildAuditFromUser(
      { sub: info.id_usuario, role: info.perfil_nombre, id_sede: idSede },
      {
        modulo: moduleName,
        submodulo: String(submodulo ?? 'GENERAL').toUpperCase(),
        tablaAfectada: details.tabla_afectada ?? adminReferenceTable(details.referencia_tipo, null),
        idRegistro: details.referencia_id ? String(details.referencia_id) : (details.id_registro ? String(details.id_registro) : null),
        accion: details.accion ?? adminActionFromMode(details.mode),
        descripcion,
        datosAnteriores: before,
        datosNuevos: after,
        camposModificados: details.campos_modificados ?? null,
        metadata: {
          referencia_tipo: details.referencia_tipo ?? null,
          referencia_id: details.referencia_id ?? null,
          mode: details.mode ?? null,
          payload_json: payload,
          source: 'admin.service'
        },
        requestId: info.request_id,
        endpoint: info.endpoint,
        httpMethod: info.http_method,
        httpStatus: info.http_status,
        sessionHash: info.session_hash,
        severidad: details.severidad ?? 'info',
        duracionMs: details.duracion_ms ?? null
      }
    )
  );

  await recordProcessTrace(connectionOrPool, {
    request_id: info.request_id,
    proceso: moduleName,
    subproceso: String(submodulo ?? 'GENERAL').toUpperCase(),
    id_sede: idSede,
    id_usuario: info.id_usuario,
    perfil_nombre: info.perfil_nombre,
    referencia_tipo: details.referencia_tipo ?? null,
    referencia_id: details.referencia_id ?? null,
    descripcion,
    endpoint: info.endpoint,
    http_method: info.http_method,
    http_status: info.http_status,
    session_hash: info.session_hash,
    payload_json: payload
  });
}

function sanitizeSiteCode(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
}

async function provisionWarehouse(connection, site, definition) {
  const warehouseCode = `${site.codigo}-${definition.suffix}`.slice(0, 20);
  const [existingRows] = await connection.execute(
    'SELECT id_almacen FROM almacenes WHERE codigo = ? LIMIT 1',
    [warehouseCode]
  );
  let warehouseId = existingRows[0]?.id_almacen ?? null;

  if (!warehouseId) {
    const [result] = await connection.execute(
      `INSERT INTO almacenes (
        id_sede, codigo, nombre, tipo, direccion, responsable, es_principal,
        temp_min, temp_max, humedad_min, humedad_max, activo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [
        site.id_sede,
        warehouseCode,
        `${definition.name} · ${site.nombre}`,
        definition.type,
        site.direccion ?? null,
        site.responsable ?? null,
        definition.primary === true,
        definition.temp_min ?? null,
        definition.temp_max ?? null,
        definition.humedad_min ?? null,
        definition.humedad_max ?? null
      ]
    );
    warehouseId = result.insertId;
  }

  for (const location of definition.locations) {
    const [locationRows] = await connection.execute(
      'SELECT id_ubicacion FROM ubicaciones_almacen WHERE id_almacen = ? AND codigo = ? LIMIT 1',
      [warehouseId, location.code]
    );

    if (!locationRows[0]) {
      await connection.execute(
        `INSERT INTO ubicaciones_almacen (
          id_almacen, codigo, nombre, tipo, permite_controlados, requiere_cadena_frio, activo
        ) VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
        [
          warehouseId,
          location.code,
          location.name,
          location.type,
          location.allowControlled === true,
          location.requiresColdChain === true
        ]
      );
    }
  }

  if (definition.type === 'frio') {
    const equipmentCode = `${site.codigo}-TH-${definition.suffix}`.slice(0, 30);
    const [equipmentRows] = await connection.execute(
      'SELECT id_equipo FROM equipos_cadena_frio WHERE codigo = ? LIMIT 1',
      [equipmentCode]
    );
    if (!equipmentRows[0]) {
      await connection.execute(
        `INSERT INTO equipos_cadena_frio (id_sede, codigo, nombre, id_almacen, marca, modelo, serial, temp_min, temp_max, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
        [
          site.id_sede,
          equipmentCode,
          `Nevera principal · ${site.nombre}`,
          warehouseId,
          'AkriSense',
          'TH-Pro',
          `${site.codigo}-AUTO`,
          definition.temp_min ?? 2,
          definition.temp_max ?? 8
        ]
      );
    }
  }

  return warehouseId;
}

async function provisionDefaultSiteStructure(connection, site) {
  const generalWarehouseId = await provisionWarehouse(connection, site, {
    suffix: 'GEN',
    name: 'Almacén general',
    type: 'general',
    primary: true,
    temp_min: 15,
    temp_max: 30,
    humedad_min: 30,
    humedad_max: 75,
    locations: [
      { code: 'RECEP', name: 'Recepción', type: 'anaquel' },
      { code: 'DISP', name: 'Despacho', type: 'despacho' },
      { code: 'CUAR', name: 'Cuarentena', type: 'cuarentena' }
    ]
  });

  await provisionWarehouse(connection, site, {
    suffix: 'FRI',
    name: 'Cadena de frío',
    type: 'frio',
    temp_min: 2,
    temp_max: 8,
    humedad_min: null,
    humedad_max: null,
    locations: [
      { code: 'NEV-01', name: 'Nevera principal', type: 'refrigerador', requiresColdChain: true },
      { code: 'DSP-F', name: 'Despacho frío', type: 'despacho', requiresColdChain: true }
    ]
  });

  await provisionWarehouse(connection, site, {
    suffix: 'CTL',
    name: 'Controlados',
    type: 'controlados',
    temp_min: 15,
    temp_max: 25,
    humidity_min: 30,
    humidity_max: 70,
    locations: [
      { code: 'CTL-01', name: 'Gabeta controlados', type: 'controlados', allowControlled: true },
      { code: 'DSP-C', name: 'Despacho controlados', type: 'despacho', allowControlled: true }
    ]
  });

  return generalWarehouseId;
}


async function closeActiveSessions(connectionOrPool, idUsuario) {
  const exec = connectionOrPool?.execute ? connectionOrPool : { execute: async (sql, params) => query(sql, params) };
  await exec.execute(
    `UPDATE sesiones
        SET es_activa = FALSE,
            fecha_cierre = NOW(),
            motivo_cierre = 'forzado_admin'
      WHERE id_usuario = ? AND es_activa = TRUE`,
    [idUsuario]
  ).catch(() => null);
}

async function getSiteStats(idSede) {
  const [inventoryRows, activeUsersRows, assignedUsersRows, requestRows] = await Promise.all([
    query(
      `SELECT
          COALESCE(SUM(stock_disponible),0) AS stock_disponible,
          COALESCE(SUM(stock_reservado),0) AS stock_reservado,
          COALESCE(SUM(stock_cuarentena),0) AS stock_cuarentena,
          COALESCE(COUNT(DISTINCT CASE WHEN stock_disponible > 0 OR stock_reservado > 0 OR stock_cuarentena > 0 THEN id_producto END),0) AS productos_con_stock
       FROM vw_inventario_local_sede
      WHERE id_sede = ?`,
      [idSede]
    ).catch(() => [{ stock_disponible: 0, stock_reservado: 0, stock_cuarentena: 0, productos_con_stock: 0 }]),
    query(
      `SELECT COUNT(DISTINCT u.id_usuario) AS total
         FROM usuarios_sedes us
         INNER JOIN usuarios u ON u.id_usuario = us.id_usuario
        WHERE us.id_sede = ? AND u.es_activo = TRUE`,
      [idSede]
    ).catch(() => [{ total: 0 }]),
    query(`SELECT COUNT(*) AS total FROM usuarios_sedes WHERE id_sede = ?`, [idSede]).catch(() => [{ total: 0 }]),
    query(
      `SELECT COUNT(*) AS total
         FROM solicitudes_compra_sedes
        WHERE (id_sede_origen = ? OR id_sede_central = ?)
          AND estado IN ('pendiente','revisada','aprobada')`,
      [idSede, idSede]
    ).catch(() => [{ total: 0 }])
  ]);

  const inventory = inventoryRows[0] || {};
  return {
    stock_disponible: Number(inventory.stock_disponible ?? 0),
    stock_reservado: Number(inventory.stock_reservado ?? 0),
    stock_cuarentena: Number(inventory.stock_cuarentena ?? 0),
    productos_con_stock: Number(inventory.productos_con_stock ?? 0),
    usuarios_activos: Number(activeUsersRows[0]?.total ?? 0),
    usuarios_asignados: Number(assignedUsersRows[0]?.total ?? 0),
    solicitudes_pendientes: Number(requestRows[0]?.total ?? 0)
  };
}

async function assertSiteCanBeDisabled(idSede) {
  const stats = await getSiteStats(idSede);
  if (stats.productos_con_stock > 0 || stats.stock_disponible > 0.0001 || stats.stock_reservado > 0.0001 || stats.stock_cuarentena > 0.0001) {
    throw new HttpError(409, 'No se puede desactivar la sede porque aún tiene stock activo. Traslada o ajusta el inventario primero.');
  }
  if (stats.usuarios_activos > 0 || stats.usuarios_asignados > 0) {
    throw new HttpError(409, 'No se puede desactivar la sede porque aún tiene usuarios asignados o activos. Reasígnalos o desactívalos primero.');
  }
  if (stats.solicitudes_pendientes > 0) {
    throw new HttpError(409, 'No se puede desactivar la sede porque tiene solicitudes de compra pendientes.');
  }
  return stats;
}

async function syncUserSites(connection, userId, primarySiteId, siteIds = [], canAdminSite = false) {
  const uniqueSiteIds = Array.from(new Set(
    [primarySiteId, ...siteIds]
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  ));

  await connection.execute(`DELETE FROM usuarios_sedes WHERE id_usuario = ?`, [userId]);

  for (const siteId of uniqueSiteIds) {
    await connection.execute(
      `INSERT INTO usuarios_sedes (id_usuario, id_sede, es_predeterminada, puede_admin_sede)
       VALUES (?, ?, ?, ?)`,
      [userId, siteId, siteId === Number(primarySiteId), canAdminSite]
    );
  }
}

export async function listAdminAudit(filter = {}) {
  await ensureRuntimeSchema({ force: true });
  const rows = await query(
    `SELECT
        la.id_log,
        la.fecha_hora,
        la.id_usuario,
        u.nombre_completo AS usuario,
        la.perfil_nombre,
        la.id_sede,
        s.nombre AS sede,
        la.modulo,
        la.submodulo,
        la.tabla_afectada,
        la.id_registro,
        la.accion,
        la.descripcion,
        la.datos_anteriores,
        la.datos_nuevos,
        la.campos_modificados,
        la.metadata,
        la.mensaje_error,
        la.request_id,
        la.endpoint,
        la.http_method,
        la.http_status,
        la.severidad,
        la.session_hash,
        la.duracion_ms
      FROM log_auditoria la
      LEFT JOIN usuarios u ON u.id_usuario = la.id_usuario
      LEFT JOIN sedes s ON s.id_sede = la.id_sede
      WHERE (? = '' OR la.descripcion LIKE ? OR u.nombre_completo LIKE ? OR la.perfil_nombre LIKE ? OR la.endpoint LIKE ? OR la.request_id LIKE ?)
        AND (? IS NULL OR la.id_sede = ?)
        AND (? IS NULL OR la.id_usuario = ?)
        AND (? = '' OR la.accion = ?)
        AND (? = '' OR la.fecha_hora >= ?)
        AND (? = '' OR la.fecha_hora <= ?)
      ORDER BY la.fecha_hora DESC
      LIMIT ${Math.max(1, Math.min(Number(filter.limit ?? 200), 500))}`,
    [
      String(filter.search ?? '').trim(),
      `%${String(filter.search ?? '').trim()}%`, `%${String(filter.search ?? '').trim()}%`, `%${String(filter.search ?? '').trim()}%`, `%${String(filter.search ?? '').trim()}%`, `%${String(filter.search ?? '').trim()}%`,
      filter.id_sede ? Number(filter.id_sede) : null,
      filter.id_sede ? Number(filter.id_sede) : null,
      filter.id_usuario ? Number(filter.id_usuario) : null,
      filter.id_usuario ? Number(filter.id_usuario) : null,
      String(filter.accion ?? '').toUpperCase(),
      String(filter.accion ?? '').toUpperCase(),
      String(filter.date_from ?? ''),
      String(filter.date_from ?? ''),
      String(filter.date_to ?? ''),
      String(filter.date_to ?? '')
    ]
  );
  return rows
    .map((row) => ({
      ...row,
      datos_anteriores: parseJson(row.datos_anteriores, null),
      datos_nuevos: parseJson(row.datos_nuevos, null),
      campos_modificados: parseJson(row.campos_modificados, null),
      metadata: parseJson(row.metadata, null)
    }))
    .filter((row) => adminAuditMatchesScope(filter.scope, row));
}

export async function getSiteAuditTimeline(idSede, limit = 120) {
  const rows = await listAdminAudit({ scope: 'sites', id_sede: idSede, limit });
  return rows.filter((row) => Number(row.id_sede || 0) === Number(idSede) || (String(row.tabla_afectada || '').toLowerCase() === 'sedes' && Number(row.id_registro || 0) === Number(idSede)));
}

export async function getAdminLookups() {
  const [sites, roles, warehouses, usabilityRows] = await Promise.all([
    query(`SELECT id_sede, codigo, nombre, ciudad, activo FROM sedes ORDER BY es_principal DESC, nombre ASC`),
    query(`SELECT id_rol, nombre, descripcion, nivel_jerarquia, es_activo FROM roles ORDER BY nivel_jerarquia ASC, nombre ASC`),
    query(`SELECT a.id_almacen, a.id_sede, a.codigo, a.nombre, a.tipo, s.nombre AS sede FROM almacenes a INNER JOIN sedes s ON s.id_sede = a.id_sede WHERE a.activo = TRUE ORDER BY s.nombre ASC, a.nombre ASC`),
    query(`SELECT DISTINCT clave, nombre, descripcion, categoria FROM role_usabilities ORDER BY categoria ASC, clave ASC`).catch(() => [])
  ]);

  const usabilityMap = new Map();
  for (const item of USABILITY_CATALOG) usabilityMap.set(item.clave, { ...item });
  for (const row of usabilityRows) {
    if (!usabilityMap.has(row.clave)) {
      usabilityMap.set(row.clave, { clave: row.clave, nombre: row.nombre, descripcion: row.descripcion, categoria: row.categoria });
    }
  }

  return {
    sites,
    roles,
    warehouses,
    permission_fields: ROLE_PERMISSION_FIELDS,
    usability_catalog: Array.from(usabilityMap.values()).sort((a, b) => String(a.categoria).localeCompare(String(b.categoria)) || String(a.nombre).localeCompare(String(b.nombre)))
  };
}

export async function listSites() {
  return query(
    `SELECT
        s.*,
        COUNT(DISTINCT a.id_almacen) AS almacenes,
        COUNT(DISTINCT u.id_usuario) AS usuarios,
        COUNT(DISTINCT eq.id_equipo) AS equipos_frio,
        COALESCE(inv.stock_local, 0) AS stock_local,
        COALESCE(inv.valor_local, 0) AS valor_local,
        COALESCE(req.pendientes_compra, 0) AS pendientes_compra
     FROM sedes s
     LEFT JOIN almacenes a ON a.id_sede = s.id_sede
     LEFT JOIN usuarios_sedes us ON us.id_sede = s.id_sede
     LEFT JOIN usuarios u ON u.id_usuario = us.id_usuario AND u.es_activo = TRUE
     LEFT JOIN equipos_cadena_frio eq ON eq.id_sede = s.id_sede AND eq.activo = TRUE
     LEFT JOIN (SELECT id_sede, SUM(stock_disponible) AS stock_local, SUM(valor_costo) AS valor_local FROM vw_inventario_local_sede GROUP BY id_sede) inv ON inv.id_sede = s.id_sede
     LEFT JOIN (SELECT id_sede_central, COUNT(*) AS pendientes_compra FROM solicitudes_compra_sedes WHERE estado IN ('pendiente','revisada','aprobada') GROUP BY id_sede_central) req ON req.id_sede_central = s.id_sede
     GROUP BY s.id_sede
     ORDER BY s.es_principal DESC, s.nombre ASC`
  );
}

export async function createSite(payload = {}) {
  return withTransaction(async (connection) => {
    const normalizedCode = sanitizeSiteCode(payload.codigo || payload.nombre);
    if (!normalizedCode) throw new HttpError(400, 'La sede requiere un código válido');

    if (payload.es_principal) {
      await connection.execute(`UPDATE sedes SET es_principal = FALSE WHERE es_principal = TRUE`);
    }

    const [result] = await connection.execute(
      `INSERT INTO sedes (codigo, nombre, ciudad, direccion, telefono, email, responsable, es_principal, activo, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [normalizedCode, payload.nombre, payload.ciudad ?? null, payload.direccion ?? null, payload.telefono ?? null, payload.email ?? null, payload.responsable ?? null, Boolean(payload.es_principal), payload.activo !== false, payload.creado_por ?? null]
    );

    const site = { id_sede: result.insertId, codigo: normalizedCode, nombre: payload.nombre, ciudad: payload.ciudad ?? null, direccion: payload.direccion ?? null, telefono: payload.telefono ?? null, email: payload.email ?? null, responsable: payload.responsable ?? null, es_principal: Boolean(payload.es_principal), activo: payload.activo !== false };
    const primaryWarehouseId = await provisionDefaultSiteStructure(connection, site);

    if (payload.creado_por) {
      await connection.execute(
        `INSERT INTO usuarios_sedes (id_usuario, id_sede, es_predeterminada, puede_admin_sede)
         VALUES (?, ?, FALSE, TRUE)
         ON DUPLICATE KEY UPDATE puede_admin_sede = TRUE`,
        [payload.creado_por, result.insertId]
      );
      const [currentUserRows] = await connection.execute(`SELECT id_almacen_principal FROM usuarios WHERE id_usuario = ? LIMIT 1`, [payload.creado_por]);
      if (!currentUserRows[0]?.id_almacen_principal) {
        await connection.execute(`UPDATE usuarios SET id_almacen_principal = ? WHERE id_usuario = ?`, [primaryWarehouseId, payload.creado_por]);
      }
    }

    const [rows] = await connection.execute(`SELECT * FROM sedes WHERE id_sede = ?`, [result.insertId]);
    await recordAdminTrace(connection, payload.actor ?? payload, 'SEDES', `Creó la sede ${payload.nombre} (${normalizedCode})`, {
      referencia_tipo: 'SEDE',
      referencia_id: result.insertId,
      id_sede: result.insertId,
      mode: 'create',
      payload_json: { codigo: normalizedCode, nombre: payload.nombre, es_principal: Boolean(payload.es_principal) }
    });
    return rows[0];
  });
}

export async function updateSite(idSede, payload = {}) {
  const currentRows = await query(`SELECT * FROM sedes WHERE id_sede = ?`, [idSede]);
  const current = currentRows[0];
  if (!current) throw new HttpError(404, 'Sede no encontrada');
  const merged = { ...current, ...payload };

  if (merged.es_principal) {
    await query(`UPDATE sedes SET es_principal = FALSE WHERE id_sede <> ?`, [idSede]);
  }
  if (Boolean(current.activo) && merged.activo === false) {
    await assertSiteCanBeDisabled(idSede);
  }

  await query(
    `UPDATE sedes SET codigo = ?, nombre = ?, ciudad = ?, direccion = ?, telefono = ?, email = ?, responsable = ?, es_principal = ?, activo = ? WHERE id_sede = ?`,
    [merged.codigo, merged.nombre, merged.ciudad ?? null, merged.direccion ?? null, merged.telefono ?? null, merged.email ?? null, merged.responsable ?? null, Boolean(merged.es_principal), merged.activo !== false, idSede]
  );

  const rows = await query(`SELECT * FROM sedes WHERE id_sede = ?`, [idSede]);
  await recordAdminTrace(query, payload.actor ?? payload, 'SEDES', `Actualizó la sede ${merged.nombre} (${merged.codigo})`, {
    referencia_tipo: 'SEDE',
    referencia_id: idSede,
    id_sede: idSede,
    mode: 'update',
    payload_json: { before: { nombre: current.nombre, activo: Boolean(current.activo), es_principal: Boolean(current.es_principal) }, after: { nombre: merged.nombre, activo: Boolean(merged.activo), es_principal: Boolean(merged.es_principal) } }
  });
  return rows[0];
}

export async function deleteSite(idSede, actor = null) {
  const rows = await query(`SELECT * FROM sedes WHERE id_sede = ?`, [idSede]);
  const current = rows[0];
  if (!current) throw new HttpError(404, 'Sede no encontrada');
  if (current.es_principal) throw new HttpError(400, 'No se puede eliminar la sede central');

  const stats = await assertSiteCanBeDisabled(idSede);
  await query(`UPDATE sedes SET activo = FALSE, eliminado_en = NOW(), eliminado_por = ? WHERE id_sede = ?`, [actorMeta(actor).id_usuario ?? null, idSede]);
  await query(`UPDATE almacenes SET activo = FALSE WHERE id_sede = ?`, [idSede]);
  await recordAdminTrace(query, actor, 'SEDES', `Desactivó la sede ${current.nombre} (${current.codigo})`, {
    referencia_tipo: 'SEDE',
    referencia_id: idSede,
    id_sede: idSede,
    mode: 'delete',
    payload_json: { before: { activo: Boolean(current.activo) }, after: { activo: false }, validacion: stats }
  });
  return { id_sede: idSede, deleted: true, mode: 'soft' };
}

export async function listProfiles() {
  const rows = await query(`SELECT r.*, COUNT(u.id_usuario) AS usuarios_asignados FROM roles r LEFT JOIN usuarios u ON u.id_rol = r.id_rol AND u.es_activo = TRUE GROUP BY r.id_rol ORDER BY r.nivel_jerarquia ASC, r.nombre ASC`);
  return rows.map((row) => ({ ...row, permisos_extra: parseJson(row.permisos_extra, {}), usuarios_asignados: Number(row.usuarios_asignados ?? 0) }));
}

export async function createProfile(payload = {}, actor = null) {
  const role = normalizeRolePayload(payload);
  if (!role.nombre) throw new HttpError(400, 'El perfil requiere nombre');
  const result = await query(
    `INSERT INTO roles (
      nombre, descripcion, nivel_jerarquia,
      perm_inventario_consulta, perm_inventario_movimiento, perm_inventario_ajuste,
      perm_compras_solicitar, perm_compras_aprobar, perm_compras_recibir,
      perm_ventas_dispensar, perm_ventas_facturar, perm_ventas_devolucion,
      perm_controlados_dispensar, perm_controlados_libro,
      perm_cadena_frio_consulta, perm_cadena_frio_registro, perm_cadena_frio_aprobar_excursion,
      perm_farmacovigilancia, perm_reportes_operativos, perm_reportes_financieros,
      perm_configuracion, perm_usuarios_gestionar, perm_auditoria_consulta,
      perm_destruccion_autorizar, permisos_extra, es_activo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      role.nombre, role.descripcion, role.nivel_jerarquia,
      role.perm_inventario_consulta, role.perm_inventario_movimiento, role.perm_inventario_ajuste,
      role.perm_compras_solicitar, role.perm_compras_aprobar, role.perm_compras_recibir,
      role.perm_ventas_dispensar, role.perm_ventas_facturar, role.perm_ventas_devolucion,
      role.perm_controlados_dispensar, role.perm_controlados_libro,
      role.perm_cadena_frio_consulta, role.perm_cadena_frio_registro, role.perm_cadena_frio_aprobar_excursion,
      role.perm_farmacovigilancia, role.perm_reportes_operativos, role.perm_reportes_financieros,
      role.perm_configuracion, role.perm_usuarios_gestionar, role.perm_auditoria_consulta,
      role.perm_destruccion_autorizar, role.permisos_extra ? JSON.stringify(role.permisos_extra) : null, role.es_activo
    ]
  );
  const rows = await query(`SELECT * FROM roles WHERE id_rol = ?`, [result.insertId]);
  await recordAdminTrace(query, actor ?? payload.actor ?? payload, 'PERFILES', `Creó el perfil ${role.nombre}`, {
    referencia_tipo: 'PERFIL',
    referencia_id: result.insertId,
    mode: 'create',
    payload_json: { nombre: role.nombre, nivel_jerarquia: role.nivel_jerarquia, es_activo: Boolean(role.es_activo) }
  });
  return { ...rows[0], permisos_extra: parseJson(rows[0]?.permisos_extra, {}) };
}

export async function updateProfile(idRol, payload = {}, actor = null) {
  const rows = await query(`SELECT * FROM roles WHERE id_rol = ?`, [idRol]);
  const current = rows[0];
  if (!current) throw new HttpError(404, 'Perfil no encontrado');
  const role = normalizeRolePayload({ ...current, ...payload });
  await query(
    `UPDATE roles SET
      nombre = ?, descripcion = ?, nivel_jerarquia = ?,
      perm_inventario_consulta = ?, perm_inventario_movimiento = ?, perm_inventario_ajuste = ?,
      perm_compras_solicitar = ?, perm_compras_aprobar = ?, perm_compras_recibir = ?,
      perm_ventas_dispensar = ?, perm_ventas_facturar = ?, perm_ventas_devolucion = ?,
      perm_controlados_dispensar = ?, perm_controlados_libro = ?,
      perm_cadena_frio_consulta = ?, perm_cadena_frio_registro = ?, perm_cadena_frio_aprobar_excursion = ?,
      perm_farmacovigilancia = ?, perm_reportes_operativos = ?, perm_reportes_financieros = ?,
      perm_configuracion = ?, perm_usuarios_gestionar = ?, perm_auditoria_consulta = ?,
      perm_destruccion_autorizar = ?, permisos_extra = ?, es_activo = ?
     WHERE id_rol = ?`,
    [
      role.nombre, role.descripcion, role.nivel_jerarquia,
      role.perm_inventario_consulta, role.perm_inventario_movimiento, role.perm_inventario_ajuste,
      role.perm_compras_solicitar, role.perm_compras_aprobar, role.perm_compras_recibir,
      role.perm_ventas_dispensar, role.perm_ventas_facturar, role.perm_ventas_devolucion,
      role.perm_controlados_dispensar, role.perm_controlados_libro,
      role.perm_cadena_frio_consulta, role.perm_cadena_frio_registro, role.perm_cadena_frio_aprobar_excursion,
      role.perm_farmacovigilancia, role.perm_reportes_operativos, role.perm_reportes_financieros,
      role.perm_configuracion, role.perm_usuarios_gestionar, role.perm_auditoria_consulta,
      role.perm_destruccion_autorizar, role.permisos_extra ? JSON.stringify(role.permisos_extra) : null, role.es_activo, idRol
    ]
  );
  const updated = await query(`SELECT * FROM roles WHERE id_rol = ?`, [idRol]);
  await recordAdminTrace(query, actor ?? payload.actor ?? payload, 'PERFILES', `Actualizó el perfil ${role.nombre}`, {
    referencia_tipo: 'PERFIL',
    referencia_id: idRol,
    mode: 'update',
    payload_json: { before: { nombre: current.nombre, nivel_jerarquia: Number(current.nivel_jerarquia), es_activo: Boolean(current.es_activo) }, after: { nombre: role.nombre, nivel_jerarquia: Number(role.nivel_jerarquia), es_activo: Boolean(role.es_activo) } }
  });
  return { ...updated[0], permisos_extra: parseJson(updated[0]?.permisos_extra, {}) };
}

export async function listUsers(filterOrSearch = '') {
  const filterObject = typeof filterOrSearch === 'object' && filterOrSearch !== null ? filterOrSearch : { search: filterOrSearch };
  const search = String(filterObject.search ?? '').trim();
  const wildcard = `%${search}%`;
  const idSede = filterObject.id_sede ? Number(filterObject.id_sede) : null;
  const idRol = filterObject.id_rol ? Number(filterObject.id_rol) : null;
  const active = typeof filterObject.active === 'boolean'
    ? filterObject.active
    : (String(filterObject.active ?? '') === 'true' ? true : (String(filterObject.active ?? '') === 'false' ? false : null));

  const rows = await query(
    `SELECT
        u.id_usuario,
        u.username,
        u.nombre,
        u.apellido_paterno,
        u.apellido_materno,
        u.nombre_completo,
        u.email,
        u.telefono_movil,
        u.numero_empleado,
        u.cedula_profesional,
        u.es_activo,
        u.fecha_ingreso,
        u.ultimo_acceso,
        u.id_rol,
        u.id_sede,
        u.id_almacen_principal,
        r.nombre AS perfil,
        s.nombre AS sede,
        a.nombre AS almacen_principal,
        (SELECT COUNT(*) FROM usuarios_sedes us WHERE us.id_usuario = u.id_usuario) AS sedes_asignadas
     FROM usuarios u
     INNER JOIN roles r ON r.id_rol = u.id_rol
     LEFT JOIN sedes s ON s.id_sede = u.id_sede
     LEFT JOIN almacenes a ON a.id_almacen = u.id_almacen_principal
     WHERE (? = '' OR u.username LIKE ? OR u.email LIKE ? OR u.nombre_completo LIKE ? OR r.nombre LIKE ? OR s.nombre LIKE ?)
       AND (? IS NULL OR u.id_sede = ?)
       AND (? IS NULL OR u.id_rol = ?)
       AND (? IS NULL OR u.es_activo = ?)
     ORDER BY u.es_activo DESC, u.nombre_completo ASC`,
    [search, wildcard, wildcard, wildcard, wildcard, wildcard, idSede, idSede, idRol, idRol, active, active]
  );
  const accessRows = await query(`SELECT us.id_usuario, us.id_sede, us.es_predeterminada, us.puede_admin_sede, s.nombre FROM usuarios_sedes us INNER JOIN sedes s ON s.id_sede = us.id_sede ORDER BY s.nombre ASC`);
  const accessMap = new Map();
  for (const row of accessRows) {
    const list = accessMap.get(row.id_usuario) ?? [];
    list.push(row);
    accessMap.set(row.id_usuario, list);
  }
  return rows.map((row) => ({ ...row, access: accessMap.get(row.id_usuario) ?? [] }));
}

export async function deleteProfile(idRol, actor = null, options = {}) {
  const rows = await query(`SELECT * FROM roles WHERE id_rol = ?`, [idRol]);
  const current = rows[0];
  if (!current) throw new HttpError(404, 'Perfil no encontrado');
  if (String(current.nombre).toUpperCase() === 'ADMINISTRADOR') {
    throw new HttpError(400, 'No se puede eliminar el perfil administrador principal');
  }
  const usage = await query(`SELECT COUNT(*) AS total FROM usuarios WHERE id_rol = ?`, [idRol]);
  const assignedUsers = Number(usage[0]?.total ?? 0);
  const reassignTo = options.reassign_to ? Number(options.reassign_to) : null;

  if (assignedUsers > 0 && !reassignTo) {
    throw new HttpError(409, 'El perfil está en uso. Reasigna los usuarios existentes a otro perfil antes de eliminarlo.');
  }
  if (assignedUsers > 0 && reassignTo) {
    if (reassignTo === idRol) throw new HttpError(400, 'El perfil de reasignación debe ser diferente al perfil a eliminar.');
    const targetRows = await query(`SELECT id_rol, nombre, es_activo FROM roles WHERE id_rol = ?`, [reassignTo]);
    const target = targetRows[0];
    if (!target || !target.es_activo) throw new HttpError(400, 'El perfil de reasignación no existe o está inactivo.');
    await query(`UPDATE usuarios SET id_rol = ? WHERE id_rol = ?`, [reassignTo, idRol]);
  }
  await query(`DELETE FROM role_usabilities WHERE id_rol = ?`, [idRol]);
  await query(`DELETE FROM roles WHERE id_rol = ?`, [idRol]);
  await recordAdminTrace(query, actor, 'PERFILES', `Eliminó el perfil ${current.nombre}`, {
    referencia_tipo: 'PERFIL',
    referencia_id: idRol,
    mode: 'delete',
    payload_json: { before: { id_rol: idRol, nombre: current.nombre }, after: null, reassign_to: reassignTo, usuarios_asignados: assignedUsers }
  });
  return { id_rol: idRol, deleted: true, mode: 'hard', assigned_users: assignedUsers, reassign_to: reassignTo };
}

export async function reassignUsersAndDeleteProfile(idRol, targetRoleId, actor = null) {
  return deleteProfile(idRol, actor, { reassign_to: targetRoleId });
}

export async function deleteUser(idUsuario, actor = null) {
  const rows = await query(`SELECT id_usuario, username, nombre_completo, es_activo FROM usuarios WHERE id_usuario = ?`, [idUsuario]);
  const current = rows[0];
  if (!current) throw new HttpError(404, 'Usuario no encontrado');
  const actorInfo = actorMeta(actor);
  if (actorInfo.id_usuario && Number(actorInfo.id_usuario) === Number(idUsuario)) {
    throw new HttpError(400, 'No puedes desactivar tu propio usuario desde esta sesión');
  }
  await query(`UPDATE usuarios SET es_activo = FALSE, bloqueado = TRUE, motivo_bloqueo = 'Desactivado por administración', modificado_por = ? WHERE id_usuario = ?`, [actorInfo.id_usuario ?? null, idUsuario]);
  await closeActiveSessions(query, idUsuario);
  await recordAdminTrace(query, actor, 'USUARIOS', `Desactivó el usuario ${current.nombre_completo || current.username}`, {
    referencia_tipo: 'USUARIO',
    referencia_id: idUsuario,
    mode: 'delete',
    payload_json: { before: { es_activo: Boolean(current.es_activo) }, after: { es_activo: false } }
  });
  return { id_usuario: idUsuario, username: current.username, nombre_completo: current.nombre_completo, deleted: true, mode: 'soft' };
}

export async function assignProfileToUser(idUsuario, payload = {}, actor = null) {
  const [current] = await query(`SELECT id_usuario, id_sede FROM usuarios WHERE id_usuario = ?`, [idUsuario]);
  if (!current) throw new HttpError(404, 'Usuario no encontrado');
  return updateUser(idUsuario, {
    id_rol: Number(payload.id_rol),
    id_sede: Number(payload.id_sede ?? current.id_sede),
    site_ids: payload.site_ids ?? [],
    puede_admin_sede: payload.puede_admin_sede ?? false,
    modificado_por: payload.modificado_por ?? null,
    actor: actor ?? payload.actor ?? payload,
    _trace_subproceso: 'USUARIOS_PERFILES'
  });
}

export async function createUser(payload = {}) {
  return withTransaction(async (connection) => {
    const passwordHash = hashPassword(payload.password);
    const [result] = await connection.execute(
      `INSERT INTO usuarios (
        username, password_hash, nombre, apellido_paterno, apellido_materno, email,
        telefono_movil, id_rol, id_sede, id_almacen_principal, numero_empleado,
        cedula_profesional, fecha_ingreso, turno, es_activo, requiere_cambio_password, creado_por, modificado_por
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [payload.username, passwordHash, payload.nombre, payload.apellido_paterno, payload.apellido_materno ?? null, payload.email, payload.telefono_movil ?? null, payload.id_rol, payload.id_sede, payload.id_almacen_principal ?? null, payload.numero_empleado ?? null, payload.cedula_profesional ?? null, payload.fecha_ingreso ?? null, payload.turno ?? 'matutino', payload.es_activo ?? true, payload.requiere_cambio_password ?? false, payload.creado_por ?? null, payload.creado_por ?? null]
    );
    await syncUserSites(connection, result.insertId, payload.id_sede, payload.site_ids ?? [], Boolean(payload.puede_admin_sede));
    const rows = await query(`SELECT u.id_usuario, u.username, u.nombre_completo, u.email, r.nombre AS perfil, s.nombre AS sede FROM usuarios u INNER JOIN roles r ON r.id_rol = u.id_rol LEFT JOIN sedes s ON s.id_sede = u.id_sede WHERE u.id_usuario = ?`, [result.insertId]);
    await recordAdminTrace(connection, payload.actor ?? payload, 'USUARIOS', `Creó el usuario ${payload.username}`, {
      referencia_tipo: 'USUARIO',
      referencia_id: result.insertId,
      id_sede: Number(payload.id_sede) || null,
      mode: 'create',
      payload_json: { username: payload.username, id_rol: Number(payload.id_rol), site_ids: payload.site_ids ?? [], puede_admin_sede: Boolean(payload.puede_admin_sede) }
    });
    return rows[0];
  });
}

export async function updateUser(idUsuario, payload = {}) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute(`SELECT * FROM usuarios WHERE id_usuario = ?`, [idUsuario]);
    const current = rows[0];
    if (!current) throw new HttpError(404, 'Usuario no encontrado');
    const merged = { ...current, ...payload };
    const passwordHash = payload.password ? hashPassword(payload.password) : current.password_hash;
    await connection.execute(
      `UPDATE usuarios SET
        username = ?, password_hash = ?, nombre = ?, apellido_paterno = ?, apellido_materno = ?,
        email = ?, telefono_movil = ?, id_rol = ?, id_sede = ?, id_almacen_principal = ?,
        numero_empleado = ?, cedula_profesional = ?, fecha_ingreso = ?, turno = ?, es_activo = ?,
        requiere_cambio_password = ?, modificado_por = ?
       WHERE id_usuario = ?`,
      [merged.username, passwordHash, merged.nombre, merged.apellido_paterno, merged.apellido_materno ?? null, merged.email, merged.telefono_movil ?? null, merged.id_rol, merged.id_sede, merged.id_almacen_principal ?? null, merged.numero_empleado ?? null, merged.cedula_profesional ?? null, merged.fecha_ingreso ?? null, merged.turno ?? 'matutino', merged.es_activo ?? true, merged.requiere_cambio_password ?? false, payload.modificado_por ?? null, idUsuario]
    );
    await syncUserSites(connection, idUsuario, merged.id_sede, payload.site_ids ?? [], Boolean(payload.puede_admin_sede));
    if (!Boolean(merged.es_activo)) {
      await closeActiveSessions(connection, idUsuario);
    }
    const refreshed = await query(`SELECT u.id_usuario, u.username, u.nombre_completo, u.email, r.nombre AS perfil, s.nombre AS sede, u.es_activo FROM usuarios u INNER JOIN roles r ON r.id_rol = u.id_rol LEFT JOIN sedes s ON s.id_sede = u.id_sede WHERE u.id_usuario = ?`, [idUsuario]);
    await recordAdminTrace(connection, payload.actor ?? payload, payload._trace_subproceso ?? 'USUARIOS', `${payload._trace_subproceso === 'USUARIOS_PERFILES' ? 'Actualizó la adjudicación de perfil/sedes del usuario' : 'Actualizó el usuario'} ${merged.username}`, {
      referencia_tipo: 'USUARIO',
      referencia_id: idUsuario,
      id_sede: Number(merged.id_sede) || null,
      mode: 'update',
      payload_json: {
        before: { id_rol: Number(current.id_rol), id_sede: Number(current.id_sede), es_activo: Boolean(current.es_activo) },
        after: { id_rol: Number(merged.id_rol), id_sede: Number(merged.id_sede), es_activo: Boolean(merged.es_activo) },
        site_ids: payload.site_ids ?? [],
        puede_admin_sede: Boolean(payload.puede_admin_sede)
      }
    });
    return refreshed[0];
  });
}

export async function listRoleUsabilities(idRol = null) {
  const params = [];
  let sql = `SELECT ru.*, r.nombre AS perfil FROM role_usabilities ru INNER JOIN roles r ON r.id_rol = ru.id_rol`;
  if (idRol) {
    sql += ' WHERE ru.id_rol = ?';
    params.push(idRol);
  }
  sql += ' ORDER BY r.nombre ASC, ru.categoria ASC, ru.clave ASC';
  try {
    const rows = await query(sql, params);
    return rows.map((row) => ({ ...row, metadata: parseJson(row.metadata, {}) }));
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    await ensureRuntimeSchema({ force: true });
    const rows = await query(sql, params);
    return rows.map((row) => ({ ...row, metadata: parseJson(row.metadata, {}) }));
  }
}

export async function replaceRoleUsabilities(idRol, items = [], actor = null) {
  await ensureRuntimeSchema({ force: true });
  return withTransaction(async (connection) => {
    await connection.execute('DELETE FROM role_usabilities WHERE id_rol = ?', [idRol]);
    for (const item of items) {
      await connection.execute(
        `INSERT INTO role_usabilities (id_rol, clave, nombre, descripcion, categoria, habilitado, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [idRol, item.clave, item.nombre, item.descripcion ?? null, item.categoria ?? 'general', item.habilitado !== false, item.metadata ? JSON.stringify(item.metadata) : null]
      );
    }
    const [rows] = await connection.execute('SELECT * FROM role_usabilities WHERE id_rol = ? ORDER BY categoria ASC, clave ASC', [idRol]);
    await recordAdminTrace(connection, actor, 'PERFILES_USABILIDADES', `Actualizó la matriz de usabilidades del perfil ${idRol}`, {
      referencia_tipo: 'PERFIL',
      referencia_id: idRol,
      mode: 'update',
      payload_json: { items: rows.length }
    });
    return rows.map((row) => ({ ...row, metadata: parseJson(row.metadata, {}) }));
  });
}
