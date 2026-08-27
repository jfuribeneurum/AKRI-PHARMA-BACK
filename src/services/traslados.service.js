import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';
import { recordProcessTrace } from './traceability.service.js';

/* ─── Crear traslado (pendiente, sin mover stock aún) ─────────────────────── */
export async function createTraslado(payload, userId) {
  // Validar existencia y stock disponible en origen
  const rows = await query(
    `SELECT e.cantidad_disponible, l.id_producto, p.nombre_comercial
     FROM existencias e
     INNER JOIN lotes l ON l.id_lote = e.id_lote
     INNER JOIN productos p ON p.id_producto = l.id_producto
     WHERE e.id_lote = ? AND e.id_ubicacion = ?`,
    [payload.id_lote, payload.id_ubicacion_origen]
  );

  if (!rows[0]) {
    throw new HttpError(400, 'No existe saldo para el lote y ubicación de origen');
  }
  if (Number(rows[0].cantidad_disponible) < Number(payload.cantidad)) {
    throw new HttpError(400, `Stock insuficiente. Disponible: ${rows[0].cantidad_disponible}`);
  }

  const idProducto = rows[0].id_producto;

  const result = await query(
    `INSERT INTO traslados
       (id_producto, id_lote, id_almacen_origen, id_ubicacion_origen,
        id_almacen_destino, id_ubicacion_destino, cantidad, motivo, id_usuario_origen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      idProducto,
      payload.id_lote,
      payload.id_almacen_origen,
      payload.id_ubicacion_origen,
      payload.id_almacen_destino,
      payload.id_ubicacion_destino,
      payload.cantidad,
      payload.motivo ?? null,
      userId ?? null
    ]
  );

  await recordProcessTrace(null, {
    proceso: 'TRASLADOS',
    subproceso: 'CREACION',
    id_usuario: userId,
    referencia_tipo: 'TRASLADO',
    referencia_id: result.insertId,
    descripcion: `Traslado #${result.insertId} creado (${rows[0].nombre_comercial ?? ''})`,
    payload_json: { id_lote: payload.id_lote, cantidad: payload.cantidad, id_almacen_destino: payload.id_almacen_destino }
  });

  return {
    id_traslado: result.insertId,
    message: 'Traslado registrado y pendiente de recepción'
  };
}

/* ─── Listar traslados ────────────────────────────────────────────────────── */
export async function listTraslados(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.estado) {
    conditions.push('t.estado = ?');
    params.push(filters.estado);
  }
  if (filters.id_almacen_destino) {
    conditions.push('t.id_almacen_destino = ?');
    params.push(filters.id_almacen_destino);
  }
  if (filters.id_almacen_origen) {
    conditions.push('t.id_almacen_origen = ?');
    params.push(filters.id_almacen_origen);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  return query(
    `SELECT
       t.id_traslado,
       t.estado,
       t.cantidad,
       t.motivo,
       t.observaciones_recepcion,
       t.fecha_envio,
       t.fecha_recepcion,
       t.id_movimiento,
       p.nombre_comercial,
       p.sku,
       l.numero_lote,
       l.fecha_vencimiento,
       ao.nombre AS almacen_origen,
       uo.nombre AS ubicacion_origen,
       ad.nombre AS almacen_destino,
       ud.nombre AS ubicacion_destino,
       uo_orig.id_usuario_origen,
       uo_dest.id_usuario_destino,
       u_orig.nombre_completo AS nombre_emisor,
       u_dest.nombre_completo AS nombre_receptor
     FROM traslados t
     INNER JOIN productos p ON p.id_producto = t.id_producto
     INNER JOIN lotes l ON l.id_lote = t.id_lote
     INNER JOIN almacenes ao ON ao.id_almacen = t.id_almacen_origen
     INNER JOIN ubicaciones_almacen uo ON uo.id_ubicacion = t.id_ubicacion_origen
     INNER JOIN almacenes ad ON ad.id_almacen = t.id_almacen_destino
     INNER JOIN ubicaciones_almacen ud ON ud.id_ubicacion = t.id_ubicacion_destino
     LEFT JOIN (SELECT id_traslado, id_usuario_origen FROM traslados) uo_orig ON uo_orig.id_traslado = t.id_traslado
     LEFT JOIN (SELECT id_traslado, id_usuario_destino FROM traslados) uo_dest ON uo_dest.id_traslado = t.id_traslado
     LEFT JOIN usuarios u_orig ON u_orig.id_usuario = t.id_usuario_origen
     LEFT JOIN usuarios u_dest ON u_dest.id_usuario = t.id_usuario_destino
     ${where}
     ORDER BY t.fecha_envio DESC
     LIMIT 200`,
    params
  );
}

/* ─── Confirmar recepción ─────────────────────────────────────────────────── */
export async function recibirTraslado(id, userId, observaciones) {
  return withTransaction(async (connection) => {
    const [tRows] = await connection.execute(
      `SELECT * FROM traslados WHERE id_traslado = ? FOR UPDATE`,
      [id]
    );
    const t = tRows[0];
    if (!t) throw new HttpError(404, 'Traslado no encontrado');
    if (t.estado !== 'pendiente') {
      throw new HttpError(400, `El traslado ya fue ${t.estado}`);
    }

    // Verificar stock origen
    const [existOrRows] = await connection.execute(
      `SELECT * FROM existencias WHERE id_lote = ? AND id_ubicacion = ? FOR UPDATE`,
      [t.id_lote, t.id_ubicacion_origen]
    );
    const existOrigen = existOrRows[0];
    if (!existOrigen || Number(existOrigen.cantidad_disponible) < Number(t.cantidad)) {
      const disp = existOrigen?.cantidad_disponible ?? 0;
      throw new HttpError(400, `Stock insuficiente en origen al momento de recibir. Disponible: ${disp}`);
    }

    // Débito en origen
    await connection.execute(
      `UPDATE existencias SET cantidad_disponible = cantidad_disponible - ?
       WHERE id_existencia = ?`,
      [t.cantidad, existOrigen.id_existencia]
    );

    // Crédito en destino
    const [existDestRows] = await connection.execute(
      `SELECT * FROM existencias WHERE id_lote = ? AND id_ubicacion = ? FOR UPDATE`,
      [t.id_lote, t.id_ubicacion_destino]
    );
    if (existDestRows[0]) {
      await connection.execute(
        `UPDATE existencias SET cantidad_disponible = cantidad_disponible + ?
         WHERE id_existencia = ?`,
        [t.cantidad, existDestRows[0].id_existencia]
      );
    } else {
      await connection.execute(
        `INSERT INTO existencias (id_lote, id_almacen, id_ubicacion, cantidad_disponible)
         VALUES (?, ?, ?, ?)`,
        [t.id_lote, t.id_almacen_destino, t.id_ubicacion_destino, t.cantidad]
      );
    }

    // Registrar movimiento de inventario
    const [movResult] = await connection.execute(
      `INSERT INTO movimientos_inventario
         (tipo, id_producto, id_lote,
          id_almacen_origen, id_ubicacion_origen,
          id_almacen_destino, id_ubicacion_destino,
          cantidad, motivo, referencia_tipo, referencia_id, id_usuario)
       VALUES ('traslado', ?, ?, ?, ?, ?, ?, ?, ?, 'TRASLADO', ?, ?)`,
      [
        t.id_producto, t.id_lote,
        t.id_almacen_origen, t.id_ubicacion_origen,
        t.id_almacen_destino, t.id_ubicacion_destino,
        t.cantidad,
        observaciones ? `Traslado #${id} recibido: ${observaciones}` : `Traslado #${id} recibido`,
        id,
        userId ?? null
      ]
    );

    // Actualizar traslado
    await connection.execute(
      `UPDATE traslados
       SET estado = 'recibido',
           id_usuario_destino = ?,
           observaciones_recepcion = ?,
           fecha_recepcion = NOW(),
           id_movimiento = ?
       WHERE id_traslado = ?`,
      [userId ?? null, observaciones ?? null, movResult.insertId, id]
    );

    await recordProcessTrace(connection, {
      proceso: 'TRASLADOS',
      subproceso: 'RECEPCION',
      id_usuario: userId,
      referencia_tipo: 'TRASLADO',
      referencia_id: id,
      descripcion: `Traslado #${id} recibido y confirmado`,
      payload_json: { id_traslado: id, cantidad: t.cantidad, id_almacen_destino: t.id_almacen_destino }
    });

    return { id_traslado: id, id_movimiento: movResult.insertId, message: 'Traslado recibido correctamente' };
  });
}

/* ─── Rechazar traslado ───────────────────────────────────────────────────── */
export async function rechazarTraslado(id, userId, motivo) {
  return withTransaction(async (connection) => {
    const [tRows] = await connection.execute(
      `SELECT * FROM traslados WHERE id_traslado = ? FOR UPDATE`,
      [id]
    );
    const t = tRows[0];
    if (!t) throw new HttpError(404, 'Traslado no encontrado');
    if (t.estado !== 'pendiente') {
      throw new HttpError(400, `El traslado ya fue ${t.estado}`);
    }

    await connection.execute(
      `UPDATE traslados
       SET estado = 'rechazado',
           id_usuario_destino = ?,
           observaciones_recepcion = ?,
           fecha_recepcion = NOW()
       WHERE id_traslado = ?`,
      [userId ?? null, motivo ?? null, id]
    );

    await recordProcessTrace(connection, {
      proceso: 'TRASLADOS',
      subproceso: 'RECHAZO',
      id_usuario: userId,
      referencia_tipo: 'TRASLADO',
      referencia_id: id,
      descripcion: `Traslado #${id} rechazado`,
      payload_json: { id_traslado: id, motivo }
    });

    return { id_traslado: id, message: 'Traslado rechazado' };
  });
}
