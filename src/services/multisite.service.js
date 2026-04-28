import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';
import { recordProcessTrace } from './traceability.service.js';

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

function hasUsability(user, key) {
  if (!user || !key) {
    return false;
  }
  if (user.role === 'ADMINISTRADOR') {
    return true;
  }
  return Array.isArray(user.usabilities) && user.usabilities.some((item) => item?.clave === key);
}

async function getCentralSite() {
  const rows = await query(
    `SELECT id_sede, codigo, nombre, es_principal
       FROM sedes
      WHERE es_principal = TRUE
        AND activo = TRUE
      ORDER BY id_sede ASC
      LIMIT 1`
  );
  return rows[0] ?? null;
}

async function getSiteById(idSede) {
  if (!idSede) return null;
  const rows = await query(
    `SELECT id_sede, codigo, nombre, ciudad, direccion, telefono, email, responsable, es_principal, activo
       FROM sedes
      WHERE id_sede = ?
      LIMIT 1`,
    [idSede]
  );
  return rows[0] ?? null;
}

async function getAuthorizedSites(userId) {
  return query(
    `SELECT us.id_sede, us.es_predeterminada, us.puede_admin_sede, s.codigo, s.nombre, s.es_principal, s.activo
       FROM usuarios_sedes us
       INNER JOIN sedes s ON s.id_sede = us.id_sede
      WHERE us.id_usuario = ?
        AND s.activo = TRUE
      ORDER BY us.es_predeterminada DESC, s.es_principal DESC, s.nombre ASC`,
    [userId]
  );
}

function normalizeActiveRequestOriginSite(authorizedSites = [], requestedSiteId = null, fallbackCurrentSite = null) {
  const numericRequested = requestedSiteId ? Number(requestedSiteId) : null;
  const authorizedPeripherals = authorizedSites.filter((site) => !Boolean(site.es_principal));
  if (numericRequested) {
    const match = authorizedPeripherals.find((site) => Number(site.id_sede) === numericRequested);
    if (match) return match;
  }
  if (fallbackCurrentSite && !Boolean(fallbackCurrentSite.es_principal)) {
    return fallbackCurrentSite;
  }
  return authorizedPeripherals[0] ?? null;
}

async function getInventorySnapshot(idSede) {
  const localRows = await query(
    `SELECT COUNT(*) AS productos, COALESCE(SUM(stock_disponible),0) AS stock_unidades, COALESCE(SUM(valor_costo),0) AS valor_costo
       FROM vw_inventario_local_sede
      WHERE id_sede = ?`,
    [idSede]
  );
  const generalRows = await query(
    `SELECT COUNT(*) AS productos, COALESCE(SUM(stock_disponible_total),0) AS stock_unidades, COALESCE(SUM(valor_costo_total),0) AS valor_costo
       FROM vw_inventario_general`
  );
  return {
    local: {
      productos: Number(localRows[0]?.productos ?? 0),
      stock_unidades: Number(localRows[0]?.stock_unidades ?? 0),
      valor_costo: Number(localRows[0]?.valor_costo ?? 0)
    },
    general: {
      productos: Number(generalRows[0]?.productos ?? 0),
      stock_unidades: Number(generalRows[0]?.stock_unidades ?? 0),
      valor_costo: Number(generalRows[0]?.valor_costo ?? 0)
    }
  };
}

async function pendingRequestsPreview(centralSiteId) {
  const rows = await query(
    `SELECT
        r.id_solicitud_compra_sede,
        r.consecutivo,
        r.estado,
        r.prioridad,
        r.fecha_solicitud,
        so.nombre AS sede_origen,
        u.nombre_completo AS solicitado_por,
        COUNT(d.id_solicitud_compra_detalle) AS items,
        COALESCE(SUM(d.cantidad_solicitada),0) AS cantidad_total
     FROM solicitudes_compra_sedes r
     INNER JOIN sedes so ON so.id_sede = r.id_sede_origen
     INNER JOIN usuarios u ON u.id_usuario = r.id_usuario_solicita
     LEFT JOIN solicitudes_compra_sedes_detalle d ON d.id_solicitud_compra_sede = r.id_solicitud_compra_sede
     WHERE r.id_sede_central = ?
       AND r.estado IN ('pendiente','revisada','aprobada')
     GROUP BY r.id_solicitud_compra_sede
     ORDER BY FIELD(r.prioridad, 'critica','alta','media','baja'), r.fecha_solicitud DESC
     LIMIT 10`,
    [centralSiteId]
  );
  return rows;
}

export async function getMultisiteContext(user) {
  const [authorizedSites, currentSite, centralSite] = await Promise.all([
    getAuthorizedSites(user.sub),
    getSiteById(user.id_sede),
    getCentralSite()
  ]);

  if (!currentSite) {
    throw new HttpError(400, 'No hay una sede activa seleccionada en la sesión');
  }

  const inventory = await getInventorySnapshot(currentSite.id_sede);
  const canManageSites = hasUsability(user, 'sites.manage');
  const canDeleteSites = hasUsability(user, 'sites.delete');
  const canManageProfiles = hasUsability(user, 'profiles.manage');
  const canAssignProfiles = hasUsability(user, 'profiles.assign');
  const canManageUsers = hasUsability(user, 'users.manage') || canAssignProfiles || canManageProfiles;
  const canDeleteUsers = hasUsability(user, 'users.delete') || hasUsability(user, 'users.manage');
  const requestOriginSites = authorizedSites.filter((site) => !Boolean(site.es_principal));
  const canRequestToCentral = requestOriginSites.length > 0 && hasUsability(user, 'requests.branch.create');
  const canReviewRequests = Boolean(currentSite.es_principal) && hasUsability(user, 'requests.central.review');
  const canManageControlCenter = hasUsability(user, 'dashboard.control.center') || canManageSites || canManageProfiles || canManageUsers || canRequestToCentral || canReviewRequests;
  const alerts = canReviewRequests && centralSite
    ? await pendingRequestsPreview(centralSite.id_sede)
    : [];

  return {
    current_site: currentSite,
    central_site: centralSite,
    authorized_sites: authorizedSites,
    request_origin_sites: requestOriginSites,
    inventory,
    permissions: {
      can_manage_sites: canManageSites,
      can_delete_sites: canDeleteSites,
      can_manage_profiles: canManageProfiles,
      can_assign_profiles: canAssignProfiles,
      can_manage_users: canManageUsers,
      can_delete_users: canDeleteUsers,
      can_manage_control_center: canManageControlCenter,
      can_request_to_central: canRequestToCentral,
      can_review_requests: canReviewRequests,
      must_select_site: authorizedSites.length > 1,
      purchase_orders_central_only: true
    },
    purchase_request_alert: {
      pending_count: alerts.length,
      items: alerts
    }
  };
}

async function nextPurchaseRequestConsecutive(connection) {
  const [rows] = await connection.execute(
    `SELECT COALESCE(MAX(id_solicitud_compra_sede), 0) + 1 AS siguiente
       FROM solicitudes_compra_sedes
      FOR UPDATE`
  );
  return `SC-${String(Number(rows[0]?.siguiente ?? 1)).padStart(6, '0')}`;
}

function normalizeItems(items = []) {
  return items
    .map((item) => ({
      id_producto: item.id_producto ? Number(item.id_producto) : null,
      descripcion_item: String(item.descripcion_item ?? item.nombre_comercial ?? '').trim(),
      cantidad_solicitada: Number(item.cantidad_solicitada ?? item.cantidad ?? 0),
      observaciones: item.observaciones ?? null
    }))
    .filter((item) => item.descripcion_item && item.cantidad_solicitada > 0);
}

async function getProductStock(idProducto, idSede) {
  const [localRows, generalRows] = await Promise.all([
    query(
      `SELECT COALESCE(stock_disponible,0) AS stock_local
         FROM vw_inventario_local_sede
        WHERE id_sede = ? AND id_producto = ?
        LIMIT 1`,
      [idSede, idProducto]
    ),
    query(
      `SELECT COALESCE(stock_disponible_total,0) AS stock_general
         FROM vw_inventario_general
        WHERE id_producto = ?
        LIMIT 1`,
      [idProducto]
    )
  ]);
  return {
    stock_local: Number(localRows[0]?.stock_local ?? 0),
    stock_general: Number(generalRows[0]?.stock_general ?? 0)
  };
}

export async function createPurchaseRequestFromBranch(payload, user) {
  const sessionSite = await getSiteById(user.id_sede);
  const centralSite = await getCentralSite();

  if (!sessionSite || !centralSite) {
    throw new HttpError(400, 'No fue posible resolver la sede actual o la sede central');
  }
  if (!hasUsability(user, 'requests.branch.create')) {
    throw new HttpError(403, 'Tu perfil no tiene habilitada la solicitud de compra a sede central');
  }

  let currentSite = sessionSite;
  const overrideSiteId = payload.id_sede_origen ? Number(payload.id_sede_origen) : null;
  if (overrideSiteId && overrideSiteId !== Number(sessionSite.id_sede)) {
    const authorizedSites = await getAuthorizedSites(user.sub);
    const requestedSite = authorizedSites.find((site) => Number(site.id_sede) === overrideSiteId && site.activo);
    if (!requestedSite) {
      throw new HttpError(403, 'La sede seleccionada no está autorizada para este usuario');
    }
    currentSite = await getSiteById(overrideSiteId);
  }

  if (currentSite.es_principal) {
    throw new HttpError(400, 'Las solicitudes de compra a central solo aplican para sedes periféricas. Selecciona una sede alterna autorizada.');
  }

  const items = normalizeItems(payload.items ?? []);
  if (!items.length) {
    throw new HttpError(400, 'La solicitud requiere al menos un ítem válido');
  }

  return withTransaction(async (connection) => {
    const consecutive = await nextPurchaseRequestConsecutive(connection);
    const [header] = await connection.execute(
      `INSERT INTO solicitudes_compra_sedes (
        consecutivo, estado, prioridad, id_sede_origen, id_sede_central, id_usuario_solicita, observaciones, metadata
      ) VALUES (?, 'pendiente', ?, ?, ?, ?, ?, ?)`,
      [
        consecutive,
        payload.prioridad ?? 'media',
        currentSite.id_sede,
        centralSite.id_sede,
        user.sub,
        payload.observaciones ?? null,
        payload.metadata ? JSON.stringify(payload.metadata) : null
      ]
    );

    for (const item of items) {
      let stockLocal = null;
      let stockGeneral = null;
      if (item.id_producto) {
        const stock = await getProductStock(item.id_producto, currentSite.id_sede);
        stockLocal = stock.stock_local;
        stockGeneral = stock.stock_general;
      }
      await connection.execute(
        `INSERT INTO solicitudes_compra_sedes_detalle (
          id_solicitud_compra_sede, id_producto, descripcion_item, cantidad_solicitada, stock_local, stock_general, observaciones
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          header.insertId,
          item.id_producto,
          item.descripcion_item,
          item.cantidad_solicitada,
          stockLocal,
          stockGeneral,
          item.observaciones
        ]
      );
    }

    await recordProcessTrace(connection, {
      proceso: 'COMPRAS',
      subproceso: 'SOLICITUD_ABASTECIMIENTO',
      id_sede: currentSite.id_sede,
      id_usuario: user.sub,
      perfil_nombre: user.role,
      referencia_tipo: 'SOLICITUD_COMPRA_SEDE',
      referencia_id: header.insertId,
      descripcion: `Solicitud ${consecutive} creada por ${currentSite.nombre}`,
      payload_json: { items: items.length, prioridad: payload.prioridad ?? 'media' }
    });

    return getPurchaseRequestById(header.insertId, user, true);
  });
}

export async function listPurchaseRequests(filter = {}, user) {
  const search = String(filter.search ?? '').trim();
  const wildcard = `%${search}%`;
  const status = String(filter.status ?? '').trim();
  const requestedScope = String(filter.scope ?? '').trim().toLowerCase();
  const currentSite = await getSiteById(user.id_sede);
  const authorizedSites = await getAuthorizedSites(user.sub);
  if (!currentSite) {
    throw new HttpError(400, 'La sesión no tiene una sede activa válida');
  }

  const params = [status, status, search, wildcard, wildcard, wildcard];
  let scopeSql = '';
  if (requestedScope === 'branch') {
    if (!hasUsability(user, 'requests.branch.create')) {
      throw new HttpError(403, 'Tu perfil no puede consultar solicitudes de sede periférica');
    }
    const originSite = normalizeActiveRequestOriginSite(authorizedSites, filter.id_sede_origen, currentSite);
    if (!originSite) {
      throw new HttpError(400, 'No hay sedes periféricas autorizadas para este usuario');
    }
    scopeSql = ' AND r.id_sede_origen = ?';
    params.push(originSite.id_sede);
  } else if (currentSite.es_principal && hasUsability(user, 'requests.central.review')) {
    scopeSql = ' AND r.id_sede_central = ?';
    params.push(currentSite.id_sede);
  } else {
    const originSite = normalizeActiveRequestOriginSite(authorizedSites, filter.id_sede_origen, currentSite);
    if (!originSite) {
      throw new HttpError(400, 'No hay sedes periféricas autorizadas para este usuario');
    }
    scopeSql = ' AND r.id_sede_origen = ?';
    params.push(originSite.id_sede);
  }

  const rows = await query(
    `SELECT
        r.id_solicitud_compra_sede,
        r.consecutivo,
        r.estado,
        r.prioridad,
        r.fecha_solicitud,
        r.fecha_revision,
        so.nombre AS sede_origen,
        sc.nombre AS sede_central,
        u.nombre_completo AS solicitado_por,
        ur.nombre_completo AS revisado_por,
        COUNT(d.id_solicitud_compra_detalle) AS items,
        COALESCE(SUM(d.cantidad_solicitada),0) AS cantidad_total,
        r.observaciones
     FROM solicitudes_compra_sedes r
     INNER JOIN sedes so ON so.id_sede = r.id_sede_origen
     INNER JOIN sedes sc ON sc.id_sede = r.id_sede_central
     INNER JOIN usuarios u ON u.id_usuario = r.id_usuario_solicita
     LEFT JOIN usuarios ur ON ur.id_usuario = r.id_usuario_revision
     LEFT JOIN solicitudes_compra_sedes_detalle d ON d.id_solicitud_compra_sede = r.id_solicitud_compra_sede
     WHERE (? = '' OR r.estado = ?)
       AND (? = '' OR r.consecutivo LIKE ? OR so.nombre LIKE ? OR u.nombre_completo LIKE ?)
       ${scopeSql}
     GROUP BY r.id_solicitud_compra_sede
     ORDER BY r.fecha_solicitud DESC
     LIMIT 200`,
    params
  );

  return rows;
}

export async function getPurchaseRequestById(id, user, bypassScope = false) {
  const currentSite = await getSiteById(user.id_sede);
  const headers = await query(
    `SELECT
        r.*,
        so.nombre AS sede_origen,
        sc.nombre AS sede_central,
        u.nombre_completo AS solicitado_por,
        ur.nombre_completo AS revisado_por
     FROM solicitudes_compra_sedes r
     INNER JOIN sedes so ON so.id_sede = r.id_sede_origen
     INNER JOIN sedes sc ON sc.id_sede = r.id_sede_central
     INNER JOIN usuarios u ON u.id_usuario = r.id_usuario_solicita
     LEFT JOIN usuarios ur ON ur.id_usuario = r.id_usuario_revision
     WHERE r.id_solicitud_compra_sede = ?`,
    [id]
  );
  const header = headers[0];
  if (!header) {
    throw new HttpError(404, 'Solicitud de compra no encontrada');
  }

  if (!bypassScope) {
    const canCentralReview = Boolean(currentSite?.es_principal) && hasUsability(user, 'requests.central.review');
    if (!canCentralReview && Number(header.id_sede_origen) !== Number(currentSite?.id_sede)) {
      throw new HttpError(403, 'No autorizado para consultar esta solicitud');
    }
  }

  const items = await query(
    `SELECT d.*, p.sku, p.codigo_barras, p.nombre_comercial, p.principio_activo, p.concentracion
       FROM solicitudes_compra_sedes_detalle d
       LEFT JOIN productos p ON p.id_producto = d.id_producto
      WHERE d.id_solicitud_compra_sede = ?
      ORDER BY d.id_solicitud_compra_detalle ASC`,
    [id]
  );

  return {
    ...header,
    metadata: parseJson(header.metadata, {}),
    items
  };
}

export async function updatePurchaseRequestStatus(id, payload, user) {
  const currentSite = await getSiteById(user.id_sede);
  if (!currentSite?.es_principal || !hasUsability(user, 'requests.central.review')) {
    throw new HttpError(403, 'Solo la sede central autorizada puede atender estas solicitudes');
  }

  const request = await getPurchaseRequestById(id, user, true);
  if (Number(request.id_sede_central) !== Number(currentSite.id_sede)) {
    throw new HttpError(403, 'La solicitud no pertenece a la sede central activa');
  }

  const nextStatus = String(payload.estado ?? '').trim();
  if (!['revisada', 'aprobada', 'rechazada', 'atendida', 'cancelada'].includes(nextStatus)) {
    throw new HttpError(400, 'Estado de solicitud inválido');
  }

  if (Array.isArray(payload.items) && payload.items.length) {
    await withTransaction(async (connection) => {
      for (const item of payload.items) {
        const detailId = Number(item.id_solicitud_compra_detalle || 0);
        if (!detailId) continue;
        await connection.execute(
          `UPDATE solicitudes_compra_sedes_detalle
              SET cantidad_solicitada = ?,
                  observaciones = COALESCE(?, observaciones)
            WHERE id_solicitud_compra_detalle = ?
              AND id_solicitud_compra_sede = ?`,
          [Number(item.cantidad_solicitada ?? 0), item.observaciones ?? null, detailId, id]
        );
      }
      await connection.execute(
        `UPDATE solicitudes_compra_sedes
            SET estado = ?,
                observaciones = COALESCE(?, observaciones),
                id_usuario_revision = ?,
                fecha_revision = NOW(),
                metadata = JSON_MERGE_PATCH(COALESCE(metadata, JSON_OBJECT()), ?)
          WHERE id_solicitud_compra_sede = ?`,
        [
          nextStatus,
          payload.observaciones ?? null,
          user.sub,
          JSON.stringify({ central_action: payload.accion ?? null, reviewed_at: new Date().toISOString(), items_modified: true }),
          id
        ]
      );
    });
  } else {
    await query(
      `UPDATE solicitudes_compra_sedes
          SET estado = ?,
              observaciones = COALESCE(?, observaciones),
              id_usuario_revision = ?,
              fecha_revision = NOW(),
              metadata = JSON_MERGE_PATCH(COALESCE(metadata, JSON_OBJECT()), ?)
        WHERE id_solicitud_compra_sede = ?`,
      [
        nextStatus,
        payload.observaciones ?? null,
        user.sub,
        JSON.stringify({ central_action: payload.accion ?? null, reviewed_at: new Date().toISOString(), items_modified: false }),
        id
      ]
    );
  }

  await recordProcessTrace(undefined, {
    proceso: 'COMPRAS',
    subproceso: 'SOLICITUD_ABASTECIMIENTO_REVISION',
    id_sede: currentSite.id_sede,
    id_usuario: user.sub,
    perfil_nombre: user.role,
    referencia_tipo: 'SOLICITUD_COMPRA_SEDE',
    referencia_id: id,
    descripcion: `Solicitud ${request.consecutivo} actualizada a ${nextStatus}`,
    payload_json: { estado: nextStatus, observaciones: payload.observaciones ?? null, items_modificados: Boolean(payload.items?.length) }
  });

  return getPurchaseRequestById(id, user, true);
}
