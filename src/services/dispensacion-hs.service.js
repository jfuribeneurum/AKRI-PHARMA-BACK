import { query, withTransaction } from '../config/db.js';
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

// Historial de entregas reales (append-only) de una formulación completa.
// dispensacion_hs_control guarda un único acumulado por medicamento — el
// detalle de cada entrega ya queda en movimientos_inventario (uno por lote
// usado), referenciado por 'DISPENSACION_HS_CONTROL' + el id de control.
export async function getHistorialEntregas(idFormulacionHs) {
  const controles = await query(
    `SELECT id, id_med_formulacion_hs, nombre_medicamento
       FROM dispensacion_hs_control
      WHERE id_formulacion_hs = ?`,
    [idFormulacionHs]
  );
  if (!controles.length) return [];

  const nombrePorControl = Object.fromEntries(controles.map(c => [c.id, c.nombre_medicamento]));
  const idsControl = controles.map(c => c.id);
  const placeholders = idsControl.map(() => '?').join(',');

  const movimientos = await query(
    `SELECT m.id_movimiento, m.referencia_id, m.fecha_hora, m.cantidad,
            l.numero_lote, a.nombre AS almacen, u.nombre_completo AS usuario
       FROM movimientos_inventario m
       LEFT JOIN lotes l      ON l.id_lote = m.id_lote
       LEFT JOIN almacenes a  ON a.id_almacen = m.id_almacen_origen
       LEFT JOIN usuarios u   ON u.id_usuario = m.id_usuario
      WHERE m.referencia_tipo = 'DISPENSACION_HS_CONTROL'
        AND m.referencia_id IN (${placeholders})
      ORDER BY m.fecha_hora DESC`,
    idsControl
  );

  return movimientos.map(m => ({
    ...m,
    nombre_medicamento: nombrePorControl[m.referencia_id] ?? null
  }));
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
  // Primera dispensación de este medicamento: si viene un acumulado manual,
  // ese es el valor real que queda guardado (no el delta de "control de entrega").
  const cantidadInicial = payload.cantidad_dispensada_total_override != null
    ? Number(payload.cantidad_dispensada_total_override)
    : cantidadDispensada;
  let estado = 'dispensado';
  if (cantidadInicial === 0) estado = 'pendiente';
  else if (cantidadInicial < cantidadFormulada) estado = 'parcial';

  // "Control de entrega" (cantidad_dispensada) es lo que realmente sale del
  // inventario ahora mismo, así que exige saber de qué lote(s) sale.
  const lotes = Array.isArray(payload.lotes) ? payload.lotes : [];
  if (cantidadDispensada > 0) {
    if (!lotes.length) {
      throw new HttpError(400, 'Debes elegir de qué lote(s) sale la cantidad a entregar.');
    }
    const totalLotes = lotes.reduce((sum, l) => sum + Number(l.cantidad), 0);
    if (totalLotes !== cantidadDispensada) {
      throw new HttpError(400,
        `La suma de los lotes elegidos (${totalLotes}) no coincide con la cantidad a entregar (${cantidadDispensada}).`
      );
    }
  }

  const nombrePaciente = (formulacion.nombre_paciente ?? '').trim();
  const fechaFormulacion = formulacion.fechaFormulacion instanceof Date
    ? formulacion.fechaFormulacion.toISOString().slice(0, 10)
    : String(formulacion.fechaFormulacion ?? '').slice(0, 10);

  return withTransaction(async (connection) => {
    const [existingRows] = await connection.execute(
      `SELECT id FROM dispensacion_hs_control WHERE id_formulacion_hs = ? AND id_med_formulacion_hs = ? LIMIT 1`,
      [id_formulacion_hs, id_med_formulacion_hs]
    );
    const esNuevo = existingRows.length === 0;
    const tieneOverride = payload.cantidad_dispensada_total_override != null;

    let idControl;
    let nuevoEstado;

    if (!esNuevo) {
      idControl = existingRows[0].id;
      const [currentRows] = await connection.execute(
        `SELECT cantidad_formulada, cantidad_dispensada FROM dispensacion_hs_control WHERE id = ?`,
        [idControl]
      );
      const yaDispensado = Number(currentRows[0].cantidad_dispensada);
      const formulado    = Number(currentRows[0].cantidad_formulada);
      const restante     = formulado - yaDispensado;

      let nuevoTotal;
      if (tieneOverride) {
        nuevoTotal = Number(payload.cantidad_dispensada_total_override);
        if (nuevoTotal > formulado) {
          throw new HttpError(400,
            `No se puede fijar un acumulado (${nuevoTotal}) mayor a lo formulado (${formulado}).`
          );
        }
      } else {
        if (cantidadDispensada > restante) {
          throw new HttpError(400,
            `Solo quedan ${restante} unidad(es) por dispensar de las ${formulado} formuladas. No se puede superar esa cantidad.`
          );
        }
        nuevoTotal = yaDispensado + cantidadDispensada;
      }
      nuevoEstado = 'parcial';
      if (nuevoTotal >= formulado) nuevoEstado = 'dispensado';
      if (nuevoTotal === 0)        nuevoEstado = 'pendiente';

      await connection.execute(
        `UPDATE dispensacion_hs_control
            SET cantidad_dispensada = ?,
                estado = ?,
                fecha_dispensacion = NOW(),
                id_usuario = ?,
                observaciones = CONCAT(COALESCE(observaciones,''), IF(? != '', CONCAT(IF(observaciones IS NOT NULL AND observaciones != '', ' | ', ''), ?), '')),
                contrato = ?,
                regimen = ?
          WHERE id = ?`,
        [nuevoTotal, nuevoEstado, userId ?? null,
         payload.observaciones ?? '', payload.observaciones ?? '',
         payload.contrato ?? null, payload.regimen ?? null, idControl]
      );
    } else {
      if (cantidadInicial > cantidadFormulada) {
        throw new HttpError(400,
          `No se puede dispensar ${cantidadInicial} unidades. La cantidad formulada es ${cantidadFormulada}.`
        );
      }
      nuevoEstado = estado;
      const [insertResult] = await connection.execute(
        `INSERT INTO dispensacion_hs_control (
           id_formulacion_hs, id_med_formulacion_hs, id_paciente_hs,
           nombre_paciente, documento_paciente, nombre_medicamento, presentacion,
           cantidad_formulada, cantidad_dispensada, estado,
           fecha_formulacion, fecha_dispensacion, id_usuario, observaciones,
           contrato, regimen
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?)`,
        [
          id_formulacion_hs,
          id_med_formulacion_hs,
          formulacion.idPaciente,
          nombrePaciente,
          formulacion.documento_paciente ?? '',
          med.nombre_medicamento ?? '',
          med.presentacion ?? null,
          cantidadFormulada,
          cantidadInicial,
          estado,
          fechaFormulacion,
          userId ?? null,
          payload.observaciones ?? null,
          payload.contrato ?? null,
          payload.regimen ?? null
        ]
      );
      idControl = insertResult.insertId;
    }

    // Descuento real de inventario, lote por lote — solo si se está
    // entregando algo en esta acción (una corrección pura de acumulado no
    // toca el inventario).
    let idProductoResuelto = null;
    if (cantidadDispensada > 0) {
      for (const linea of lotes) {
        const [stockRows] = await connection.execute(
          `SELECT e.id_existencia, e.cantidad_disponible, e.id_almacen,
                  l.id_producto, l.costo_unitario, p.es_controlado
             FROM existencias e
             INNER JOIN lotes l ON l.id_lote = e.id_lote
             INNER JOIN productos p ON p.id_producto = l.id_producto
            WHERE e.id_lote = ? AND e.id_ubicacion = ?
            FOR UPDATE`,
          [linea.id_lote, linea.id_ubicacion]
        );
        const stock = stockRows[0];
        if (!stock) {
          throw new HttpError(404, `No hay existencias para el lote ${linea.id_lote} en la ubicación indicada.`);
        }
        if (Number(stock.cantidad_disponible) < Number(linea.cantidad)) {
          throw new HttpError(400,
            `Stock insuficiente en el lote ${linea.id_lote} (disponible: ${stock.cantidad_disponible}).`
          );
        }

        idProductoResuelto = stock.id_producto;

        await connection.execute(
          `UPDATE existencias SET cantidad_disponible = cantidad_disponible - ? WHERE id_existencia = ?`,
          [linea.cantidad, stock.id_existencia]
        );

        await connection.execute(
          `INSERT INTO movimientos_inventario (
             tipo, id_producto, id_lote, id_almacen_origen, id_ubicacion_origen,
             cantidad, costo_unitario, motivo, referencia_tipo, referencia_id, id_usuario
           ) VALUES ('salida_venta', ?, ?, ?, ?, ?, ?, ?, 'DISPENSACION_HS_CONTROL', ?, ?)`,
          [
            stock.id_producto, linea.id_lote, stock.id_almacen, linea.id_ubicacion,
            linea.cantidad, stock.costo_unitario, 'Salida por dispensación HS',
            idControl, userId ?? null
          ]
        );

        if (stock.es_controlado) {
          const saldoAnterior = Number(stock.cantidad_disponible);
          const saldoNuevo = saldoAnterior - Number(linea.cantidad);
          await connection.execute(
            `INSERT INTO controlados_libro (
               tipo_movimiento, id_producto, id_lote, cantidad, saldo_anterior, saldo_nuevo,
               referencia_tipo, referencia_id, usuario_responsable
             ) VALUES ('salida', ?, ?, ?, ?, ?, 'DISPENSACION_HS_CONTROL', ?, ?)`,
            [stock.id_producto, linea.id_lote, linea.cantidad, saldoAnterior, saldoNuevo, idControl, userId ?? null]
          );
        }
      }

      if (idProductoResuelto) {
        await connection.execute(
          `UPDATE dispensacion_hs_control SET id_producto = ? WHERE id = ?`,
          [idProductoResuelto, idControl]
        );
      }
    }

    const [finalRows] = await connection.execute(`SELECT * FROM dispensacion_hs_control WHERE id = ?`, [idControl]);

    await recordProcessTrace(connection, {
      proceso: 'DISPENSACION',
      subproceso: 'DISPENSAR_MEDICAMENTO_HS',
      id_sede: idSede,
      id_usuario: userId ?? null,
      referencia_tipo: 'DISPENSACION_HS_CONTROL',
      referencia_id: idControl,
      descripcion: tieneOverride
        ? `Dispensación ${esNuevo ? 'registrada' : 'actualizada'} con acumulado manual: ${med.nombre_medicamento ?? ''} (${nuevoEstado})`
        : `Dispensación ${esNuevo ? 'registrada' : 'actualizada'}: ${med.nombre_medicamento ?? ''} (${nuevoEstado})`,
      payload_json: {
        id_formulacion_hs,
        id_med_formulacion_hs,
        cantidad_dispensada: cantidadDispensada,
        lotes,
        cantidad_dispensada_total_override: tieneOverride ? Number(payload.cantidad_dispensada_total_override) : null,
        cantidad_pendiente_antes: payload.cantidad_pendiente_antes ?? null,
        cantidad_faltante: payload.cantidad_faltante ?? null,
        contrato: payload.contrato ?? null,
        regimen: payload.regimen ?? null
      }
    });

    return finalRows[0];
  });
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
