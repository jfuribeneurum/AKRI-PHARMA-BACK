import { query } from '../config/db.js';
import { getFormulacionHSById } from './formulacion-hs.service.js';
import { HttpError } from '../utils/http-error.js';
import { recordProcessTrace } from './traceability.service.js';

export async function getControlByFormulacion(idFormulacion) {
  return query(
    `SELECT id, id_formulacion_hs, id_med_formulacion_hs, nombre_medicamento,
            cantidad_formulada, cantidad_dispensada, estado,
            fecha_formulacion, fecha_dispensacion, observaciones, id_producto,
            contrato, regimen
       FROM dispensacion_hs_control
      WHERE id_formulacion_hs = ?
      ORDER BY id ASC`,
    [idFormulacion]
  );
}

export async function getControlStatusBatch(idFormulaciones) {
  if (!idFormulaciones.length) return [];
  const placeholders = idFormulaciones.map(() => '?').join(',');
  return query(
    `SELECT id_formulacion_hs,
            SUM(cantidad_formulada)      AS total_formulado,
            SUM(cantidad_dispensada)     AS total_dispensado,
            SUM(estado = 'pendiente')    AS pendientes,
            SUM(estado = 'dispensado')   AS dispensados,
            SUM(estado = 'parcial')      AS parciales,
            SUM(estado = 'cancelado')    AS cancelados,
            MAX(fecha_dispensacion)      AS ultima_fecha_dispensacion
       FROM dispensacion_hs_control
      WHERE id_formulacion_hs IN (${placeholders})
      GROUP BY id_formulacion_hs`,
    idFormulaciones
  );
}

export async function listDispensacionesHS({ search = '', estado = '', page = 1, limit = 50 } = {}) {
  const offset    = (Math.max(1, page) - 1) * limit;
  const wild      = `%${search.trim()}%`;
  const hasSearch = search.trim() !== '';
  const hasEstado = estado.trim() !== '';

  const conditions = [];
  const params     = [];

  if (hasSearch) {
    conditions.push(`(nombre_paciente LIKE ? OR documento_paciente LIKE ? OR nombre_medicamento LIKE ?)`);
    params.push(wild, wild, wild);
  }
  if (hasEstado) {
    conditions.push(`estado = ?`);
    params.push(estado);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  return query(
    `SELECT id, id_formulacion_hs, id_med_formulacion_hs, id_paciente_hs,
            nombre_paciente, documento_paciente, nombre_medicamento, presentacion,
            cantidad_formulada, cantidad_dispensada, estado,
            fecha_formulacion, fecha_dispensacion, observaciones, id_producto,
            contrato, regimen, fecha_creacion
       FROM dispensacion_hs_control
       ${whereClause}
      ORDER BY fecha_creacion DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
}

export async function dispensarMedicamento(payload, userId, idSede = null) {
  const { id_formulacion_hs, id_med_formulacion_hs } = payload;

  const formulacion = await getFormulacionHSById(id_formulacion_hs);
  if (!formulacion) {
    throw new HttpError(404, 'Formulación no encontrada en HealthSphere');
  }

  const med = formulacion.medicamentos.find(m => m.id_med_formulacion === id_med_formulacion_hs);
  if (!med) {
    throw new HttpError(404, 'Medicamento no encontrado en la formulación');
  }

  const cantidadDispensada = Number(payload.cantidad_dispensada ?? med.cantidad);
  const cantidadFormulada  = Number(med.cantidad);
  let estado = 'dispensado';
  if (cantidadDispensada === 0) estado = 'pendiente';
  else if (cantidadDispensada < cantidadFormulada) estado = 'parcial';

  const existing = await query(
    `SELECT id FROM dispensacion_hs_control WHERE id_formulacion_hs = ? AND id_med_formulacion_hs = ? LIMIT 1`,
    [id_formulacion_hs, id_med_formulacion_hs]
  );

  const nombrePaciente = (formulacion.nombre_paciente ?? '').trim();
  const fechaFormulacion = formulacion.fechaFormulacion instanceof Date
    ? formulacion.fechaFormulacion.toISOString().slice(0, 10)
    : String(formulacion.fechaFormulacion ?? '').slice(0, 10);

  if (existing.length) {
    const [current] = await query(
      `SELECT cantidad_formulada, cantidad_dispensada FROM dispensacion_hs_control WHERE id = ?`,
      [existing[0].id]
    );
    const yaDispensado  = Number(current.cantidad_dispensada);
    const formulado     = Number(current.cantidad_formulada);
    const restante      = formulado - yaDispensado;

    if (cantidadDispensada > restante) {
      throw new HttpError(400,
        `Solo quedan ${restante} unidad(es) por dispensar de las ${formulado} formuladas. No se puede superar esa cantidad.`
      );
    }

    const nuevoTotal = yaDispensado + cantidadDispensada;
    let nuevoEstado  = 'parcial';
    if (nuevoTotal >= formulado) nuevoEstado = 'dispensado';
    if (nuevoTotal === 0)        nuevoEstado = 'pendiente';

    await query(
      `UPDATE dispensacion_hs_control
          SET cantidad_dispensada = ?,
              estado = ?,
              fecha_dispensacion = NOW(),
              id_usuario = ?,
              id_producto = ?,
              observaciones = CONCAT(COALESCE(observaciones,''), IF(? != '', CONCAT(IF(observaciones IS NOT NULL AND observaciones != '', ' | ', ''), ?), '')),
              contrato = ?,
              regimen = ?
        WHERE id = ?`,
      [nuevoTotal, nuevoEstado, userId ?? null, payload.id_producto ?? null,
       payload.observaciones ?? '', payload.observaciones ?? '',
       payload.contrato ?? null, payload.regimen ?? null, existing[0].id]
    );
    const [updated] = await query(`SELECT * FROM dispensacion_hs_control WHERE id = ?`, [existing[0].id]);

    await recordProcessTrace(null, {
      proceso: 'DISPENSACION',
      subproceso: 'DISPENSAR_MEDICAMENTO_HS',
      id_sede: idSede,
      id_usuario: userId ?? null,
      referencia_tipo: 'DISPENSACION_HS_CONTROL',
      referencia_id: existing[0].id,
      descripcion: `Dispensación actualizada: ${med.nombre_medicamento ?? ''} (${nuevoEstado})`,
      payload_json: {
        id_formulacion_hs,
        id_med_formulacion_hs,
        cantidad_dispensada: cantidadDispensada,
        contrato: payload.contrato ?? null,
        regimen: payload.regimen ?? null
      }
    });

    return updated;
  }

  if (cantidadDispensada > cantidadFormulada) {
    throw new HttpError(400,
      `No se puede dispensar ${cantidadDispensada} unidades. La cantidad formulada es ${cantidadFormulada}.`
    );
  }

  const result = await query(
    `INSERT INTO dispensacion_hs_control (
       id_formulacion_hs, id_med_formulacion_hs, id_paciente_hs,
       nombre_paciente, documento_paciente, nombre_medicamento, presentacion,
       cantidad_formulada, cantidad_dispensada, estado,
       fecha_formulacion, fecha_dispensacion, id_usuario, id_producto, observaciones,
       contrato, regimen
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
    [
      id_formulacion_hs,
      id_med_formulacion_hs,
      formulacion.idPaciente,
      nombrePaciente,
      formulacion.documento_paciente ?? '',
      med.nombre_medicamento ?? '',
      med.presentacion ?? null,
      cantidadFormulada,
      cantidadDispensada,
      estado,
      fechaFormulacion,
      userId ?? null,
      payload.id_producto ?? null,
      payload.observaciones ?? null,
      payload.contrato ?? null,
      payload.regimen ?? null
    ]
  );

  const [inserted] = await query(`SELECT * FROM dispensacion_hs_control WHERE id = ?`, [result.insertId]);

  await recordProcessTrace(null, {
    proceso: 'DISPENSACION',
    subproceso: 'DISPENSAR_MEDICAMENTO_HS',
    id_sede: idSede,
    id_usuario: userId ?? null,
    referencia_tipo: 'DISPENSACION_HS_CONTROL',
    referencia_id: result.insertId,
    descripcion: `Dispensación registrada: ${med.nombre_medicamento ?? ''} (${estado})`,
    payload_json: {
      id_formulacion_hs,
      id_med_formulacion_hs,
      cantidad_dispensada: cantidadDispensada,
      contrato: payload.contrato ?? null,
      regimen: payload.regimen ?? null
    }
  });

  return inserted;
}

export async function cancelarDispensacion(id, userId) {
  const [row] = await query(`SELECT id FROM dispensacion_hs_control WHERE id = ?`, [id]);
  if (!row) throw new HttpError(404, 'Registro no encontrado');

  await query(
    `UPDATE dispensacion_hs_control SET estado = 'cancelado', id_usuario = ? WHERE id = ?`,
    [userId ?? null, id]
  );
  return { id, estado: 'cancelado' };
}
