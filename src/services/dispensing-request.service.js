import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';
import { createDispensation } from './dispensing.service.js';
import { recordProcessTrace } from './traceability.service.js';

function toPayload(value) {
  return value ? JSON.stringify(value) : null;
}

async function ensurePatient(connection, payload) {
  if (!payload?.documento || !payload?.nombre) {
    throw new HttpError(400, 'La solicitud requiere paciente con documento y nombre');
  }
  const [existing] = await connection.execute('SELECT id_paciente FROM pacientes WHERE documento = ? LIMIT 1', [payload.documento]);
  if (existing[0]) {
    await connection.execute(
      `UPDATE pacientes SET nombre = ?, telefono = ?, direccion = ?, genero = ? WHERE id_paciente = ?`,
      [payload.nombre, payload.telefono ?? null, payload.direccion ?? null, payload.genero ?? 'O', existing[0].id_paciente]
    );
    return existing[0].id_paciente;
  }
  const [inserted] = await connection.execute(
    `INSERT INTO pacientes (documento, nombre, genero, telefono, direccion) VALUES (?, ?, ?, ?, ?)`,
    [payload.documento, payload.nombre, payload.genero ?? 'O', payload.telefono ?? null, payload.direccion ?? null]
  );
  return inserted.insertId;
}

async function nextRequestConsecutive(connection) {
  const [rows] = await connection.execute(
    `SELECT COALESCE(MAX(id_solicitud_dispensacion), 0) + 1 AS siguiente FROM solicitudes_dispensacion FOR UPDATE`
  );
  return `SOL-${String(Number(rows[0]?.siguiente ?? 1)).padStart(6, '0')}`;
}

function normalizeItems(items = []) {
  return items.map((item) => ({
    id_producto: item.id_producto ? Number(item.id_producto) : null,
    descripcion_libre: String(item.descripcion_libre ?? item.nombre_comercial ?? '').trim(),
    dosis: item.dosis ?? null,
    via_administracion: item.via_administracion ?? null,
    frecuencia: item.frecuencia ?? null,
    duracion: item.duracion ?? null,
    cantidad_solicitada: Number(item.cantidad_solicitada ?? item.cantidad ?? 0),
    observaciones: item.observaciones ?? null
  })).filter((item) => item.descripcion_libre && item.cantidad_solicitada > 0);
}

export async function listDispensingRequests(search = '', status = '') {
  const wildcard = `%${search}%`;
  return query(
    `SELECT
        s.id_solicitud_dispensacion,
        s.consecutivo,
        s.tipo_origen,
        s.estado,
        s.fecha_solicitud,
        sed.nombre AS sede,
        p.nombre AS paciente,
        p.documento AS paciente_documento,
        u.nombre_completo AS solicitado_por,
        COUNT(d.id_solicitud_detalle) AS items,
        SUM(COALESCE(d.cantidad_solicitada,0)) AS cantidad_total
     FROM solicitudes_dispensacion s
     INNER JOIN sedes sed ON sed.id_sede = s.id_sede
     INNER JOIN pacientes p ON p.id_paciente = s.id_paciente
     INNER JOIN usuarios u ON u.id_usuario = s.id_usuario_solicita
     LEFT JOIN solicitudes_dispensacion_detalle d ON d.id_solicitud_dispensacion = s.id_solicitud_dispensacion
     WHERE (? = '' OR s.estado = ?)
       AND (? = '' OR s.consecutivo LIKE ? OR p.nombre LIKE ? OR p.documento LIKE ? OR s.referencia_externa LIKE ?)
     GROUP BY s.id_solicitud_dispensacion
     ORDER BY s.fecha_solicitud DESC
     LIMIT 200`,
    [status, status, search, wildcard, wildcard, wildcard, wildcard]
  );
}

export async function getDispensingRequestById(id) {
  const headers = await query(
    `SELECT s.*, sed.nombre AS sede, p.nombre AS paciente_nombre, p.documento AS paciente_documento,
            p.telefono AS paciente_telefono, p.direccion AS paciente_direccion,
            us.nombre_completo AS solicitado_por_nombre
     FROM solicitudes_dispensacion s
     INNER JOIN sedes sed ON sed.id_sede = s.id_sede
     INNER JOIN pacientes p ON p.id_paciente = s.id_paciente
     INNER JOIN usuarios us ON us.id_usuario = s.id_usuario_solicita
     WHERE s.id_solicitud_dispensacion = ?`,
    [id]
  );
  const header = headers[0];
  if (!header) throw new HttpError(404, 'Solicitud de dispensación no encontrada');
  const items = await query(
    `SELECT d.*, pr.sku, pr.codigo_barras, pr.nombre_comercial, pr.principio_activo, pr.concentracion
     FROM solicitudes_dispensacion_detalle d
     LEFT JOIN productos pr ON pr.id_producto = d.id_producto
     WHERE d.id_solicitud_dispensacion = ?
     ORDER BY d.id_solicitud_detalle ASC`,
    [id]
  );
  return { ...header, payload_origen: header.payload_origen && typeof header.payload_origen === 'string' ? JSON.parse(header.payload_origen) : (header.payload_origen ?? null), items };
}

export async function createDispensingRequest(payload, userId, tipoOrigen = 'manual') {
  return withTransaction(async (connection) => {
    const patientId = await ensurePatient(connection, payload.paciente);
    const consecutive = payload.consecutivo?.trim() || await nextRequestConsecutive(connection);
    const items = normalizeItems(payload.items ?? []);
    if (!items.length) throw new HttpError(400, 'La solicitud requiere al menos un ítem válido');
    const [header] = await connection.execute(
      `INSERT INTO solicitudes_dispensacion (
        consecutivo, tipo_origen, estado, id_sede, id_almacen_sugerido, id_usuario_solicita,
        id_paciente, id_medico, referencia_externa, archivo_nombre, archivo_data_url, payload_origen, observaciones
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        consecutive,
        tipoOrigen,
        payload.estado ?? 'pendiente',
        payload.id_sede,
        payload.id_almacen_sugerido ?? null,
        userId,
        patientId,
        payload.id_medico ?? null,
        payload.referencia_externa ?? null,
        payload.archivo_nombre ?? null,
        payload.archivo_data_url ?? null,
        toPayload(payload.payload_origen ?? payload.raw_payload ?? null),
        payload.observaciones ?? null
      ]
    );
    for (const item of items) {
      await connection.execute(
        `INSERT INTO solicitudes_dispensacion_detalle (
          id_solicitud_dispensacion, id_producto, descripcion_libre, dosis, via_administracion,
          frecuencia, duracion, cantidad_solicitada, observaciones
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          header.insertId,
          item.id_producto,
          item.descripcion_libre,
          item.dosis,
          item.via_administracion,
          item.frecuencia,
          item.duracion,
          item.cantidad_solicitada,
          item.observaciones
        ]
      );
    }
    await recordProcessTrace(connection, {
      proceso: 'DISPENSACION',
      subproceso: 'SOLICITUD_CREACION',
      id_sede: payload.id_sede,
      id_usuario: userId,
      referencia_tipo: 'SOLICITUD_DISPENSACION',
      referencia_id: header.insertId,
      descripcion: `Solicitud ${consecutive} registrada por ${tipoOrigen}`,
      payload_json: { tipo_origen: tipoOrigen, items: items.length }
    });
    return getDispensingRequestById(header.insertId);
  });
}

export async function importDispensingRequestFromEhr(payload, userId) {
  return createDispensingRequest({ ...payload, payload_origen: payload }, userId, 'api_hce');
}

export async function createDispensingRequestFromPrescriptionScan(payload, userId) {
  if (!payload.archivo_data_url) throw new HttpError(400, 'Debes adjuntar la imagen o PDF de la fórmula médica');
  return createDispensingRequest(payload, userId, 'formula_escaneada');
}

export async function fulfillDispensingRequest(idSolicitud, payload, userId) {
  const request = await getDispensingRequestById(idSolicitud);
  if (request.estado === 'dispensada') throw new HttpError(400, 'La solicitud ya fue dispensada');
  const items = request.items.map((item) => ({
    id_lote: Number(item.id_lote ?? payload.item_lot_map?.[item.id_solicitud_detalle] ?? payload.default_id_lote ?? 0),
    cantidad: Number(item.cantidad_solicitada),
    temperatura_entrega: payload.temperatura_entrega ?? null
  }));
  if (items.some((item) => !item.id_lote)) {
    throw new HttpError(400, 'Para dispensar desde solicitud debes mapear cada ítem a un lote');
  }
  const dispensation = await createDispensation({
    consecutivo: payload.consecutivo ?? null,
    id_sede: payload.id_sede ?? request.id_sede,
    id_almacen: payload.id_almacen ?? request.id_almacen_sugerido,
    id_solicitud_dispensacion: request.id_solicitud_dispensacion,
    id_domiciliario: payload.id_domiciliario ?? null,
    usar_domiciliario_receptor: payload.usar_domiciliario_receptor ?? false,
    receptor_tipo: payload.receptor_tipo ?? 'paciente',
    receptor_nombre: payload.receptor_nombre ?? request.paciente_nombre,
    receptor_documento: payload.receptor_documento ?? request.paciente_documento,
    receptor_telefono: payload.receptor_telefono ?? request.paciente_telefono,
    receta_folio: payload.receta_folio ?? request.referencia_externa,
    observaciones: payload.observaciones ?? request.observaciones,
    paciente: {
      id_paciente: request.id_paciente,
      nombre: request.paciente_nombre,
      documento: request.paciente_documento,
      direccion: request.paciente_direccion,
      telefono: request.paciente_telefono,
      genero: request.genero ?? 'O'
    },
    firma: payload.firma,
    items
  }, userId);

  await query(
    `UPDATE solicitudes_dispensacion SET estado = 'dispensada', id_usuario_valida = ?, fecha_validacion = NOW() WHERE id_solicitud_dispensacion = ?`,
    [userId, idSolicitud]
  );

  return { solicitud: await getDispensingRequestById(idSolicitud), dispensacion: dispensation };
}
