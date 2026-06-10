import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';
import { recordProcessTrace } from './traceability.service.js';

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function ensurePatient(connection, payload) {
  if (payload.id_paciente) {
    const [rows] = await connection.execute(
      `SELECT * FROM pacientes WHERE id_paciente = ?`,
      [payload.id_paciente]
    );
    const current = rows[0];
    if (!current) {
      throw new HttpError(404, 'Paciente no encontrado');
    }

    await connection.execute(
      `UPDATE pacientes SET documento = ?, nombre = ?, telefono = ?, direccion = ?, genero = ?
       WHERE id_paciente = ?`,
      [
        payload.documento,
        payload.nombre,
        payload.telefono ?? null,
        payload.direccion ?? null,
        payload.genero ?? 'O',
        payload.id_paciente
      ]
    );
    return payload.id_paciente;
  }

  const [existingRows] = await connection.execute(
    `SELECT id_paciente FROM pacientes WHERE documento = ? LIMIT 1`,
    [payload.documento]
  );

  if (existingRows[0]) {
    await connection.execute(
      `UPDATE pacientes SET nombre = ?, telefono = ?, direccion = ?, genero = ?
       WHERE id_paciente = ?`,
      [
        payload.nombre,
        payload.telefono ?? null,
        payload.direccion ?? null,
        payload.genero ?? 'O',
        existingRows[0].id_paciente
      ]
    );
    return existingRows[0].id_paciente;
  }

  const [insertResult] = await connection.execute(
    `INSERT INTO pacientes (documento, nombre, genero, telefono, direccion)
     VALUES (?, ?, ?, ?, ?)`,
    [
      payload.documento,
      payload.nombre,
      payload.genero ?? 'O',
      payload.telefono ?? null,
      payload.direccion ?? null
    ]
  );

  return insertResult.insertId;
}

async function nextConsecutive(connection) {
  const [rows] = await connection.execute(
    `SELECT COALESCE(MAX(id_dispensacion), 0) + 1 AS siguiente FROM dispensaciones FOR UPDATE`
  );
  const next = Number(rows[0]?.siguiente ?? 1);
  return `DSP-${String(next).padStart(6, '0')}`;
}

export async function listDispensingLookups() {
  const [sites, warehouses, domiciliaries] = await Promise.all([
    query(`SELECT id_sede, codigo, nombre, ciudad FROM sedes WHERE activo = TRUE ORDER BY es_principal DESC, nombre ASC`),
    query(`SELECT a.id_almacen, a.id_sede, a.codigo, a.nombre, a.tipo, s.nombre AS sede
           FROM almacenes a
           INNER JOIN sedes s ON s.id_sede = a.id_sede
           WHERE a.activo = TRUE
           ORDER BY s.nombre ASC, a.nombre ASC`),
    query(`SELECT id_domiciliario, nombre, apellido, cedula, telefono, sexo
           FROM domiciliarios
           WHERE activo = TRUE
           ORDER BY nombre ASC, apellido ASC`)
  ]);

  return { sites, warehouses, domiciliaries };
}

export async function listAvailableDispensingItems(search = '', siteId = null) {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;
  const normalizedSiteId = Number(siteId) || 0;

  return query(
    `SELECT
        e.id_almacen,
        a.nombre AS almacen,
        a.id_sede,
        s.nombre AS sede,
        e.id_ubicacion,
        u.nombre AS ubicacion,
        l.id_lote,
        l.numero_lote,
        l.fecha_vencimiento,
        p.id_producto,
        p.sku,
        p.codigo_barras,
        p.nombre_comercial,
        p.principio_activo,
        p.concentracion,
        p.tipo_producto,
        p.mx_control,
        p.es_controlado,
        p.requiere_cadena_frio,
        p.temp_min,
        p.temp_max,
        p.precio_venta,
        ROUND(e.cantidad_disponible, 3) AS cantidad_disponible
     FROM existencias e
     INNER JOIN lotes l ON l.id_lote = e.id_lote
     INNER JOIN productos p ON p.id_producto = l.id_producto
     INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
     INNER JOIN sedes s ON s.id_sede = a.id_sede
     INNER JOIN ubicaciones_almacen u ON u.id_ubicacion = e.id_ubicacion
     WHERE e.cantidad_disponible > 0
       AND (? = 0 OR a.id_sede = ?)
       AND (? = '' OR p.nombre_comercial LIKE ? OR p.sku LIKE ? OR p.codigo_barras LIKE ? OR p.principio_activo LIKE ? OR l.numero_lote LIKE ?)
     ORDER BY s.nombre ASC, p.nombre_comercial ASC, l.fecha_vencimiento ASC`,
    [normalizedSiteId, normalizedSiteId, filter, wildcard, wildcard, wildcard, wildcard, wildcard]
  );
}

export async function listDomiciliaries(search = '', includeInactive = false) {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;

  return query(
    `SELECT
        id_domiciliario,
        nombre,
        apellido,
        cedula,
        telefono,
        sexo,
        activo,
        fecha_creacion,
        fecha_eliminacion
     FROM domiciliarios
     WHERE (? = TRUE OR activo = TRUE)
       AND (? = '' OR nombre LIKE ? OR apellido LIKE ? OR cedula LIKE ? OR telefono LIKE ?)
     ORDER BY activo DESC, nombre ASC, apellido ASC`,
    [includeInactive, filter, wildcard, wildcard, wildcard, wildcard]
  );
}

export async function createDomiciliary(payload, userId) {
  const result = await query(
    `INSERT INTO domiciliarios (nombre, apellido, cedula, telefono, sexo, creado_por)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      payload.nombre,
      payload.apellido,
      payload.cedula,
      payload.telefono,
      payload.sexo ?? 'O',
      userId ?? null
    ]
  );

  const rows = await query(`SELECT * FROM domiciliarios WHERE id_domiciliario = ?`, [result.insertId]);
  return rows[0];
}

export async function deleteDomiciliary(idDomiciliario, userId) {
  await query(
    `UPDATE domiciliarios
     SET activo = FALSE, eliminado_por = ?, fecha_eliminacion = NOW()
     WHERE id_domiciliario = ?`,
    [userId ?? null, idDomiciliario]
  );

  return { id_domiciliario: idDomiciliario, deleted: true };
}

export async function listDispensations(search = '') {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;

  return query(
    `SELECT
        d.id_dispensacion,
        d.consecutivo,
        d.fecha_hora,
        d.receptor_tipo,
        d.receptor_nombre,
        d.firma_tipo,
        d.firma_nombre,
        d.estado,
        s.nombre AS sede,
        a.nombre AS almacen,
        p.nombre AS paciente,
        p.documento AS paciente_documento,
        dom.nombre AS domiciliario_nombre,
        dom.apellido AS domiciliario_apellido,
        COUNT(dd.id_dispensacion_detalle) AS items,
        ROUND(COALESCE(SUM(dd.cantidad), 0), 3) AS unidades
     FROM dispensaciones d
     INNER JOIN sedes s ON s.id_sede = d.id_sede
     INNER JOIN almacenes a ON a.id_almacen = d.id_almacen
     INNER JOIN pacientes p ON p.id_paciente = d.id_paciente
     LEFT JOIN domiciliarios dom ON dom.id_domiciliario = d.id_domiciliario
     LEFT JOIN dispensaciones_detalle dd ON dd.id_dispensacion = d.id_dispensacion
     WHERE (? = '' OR d.consecutivo LIKE ? OR d.receptor_nombre LIKE ? OR p.nombre LIKE ? OR p.documento LIKE ?)
     GROUP BY d.id_dispensacion
     ORDER BY d.fecha_hora DESC
     LIMIT 100`,
    [filter, wildcard, wildcard, wildcard, wildcard]
  );
}

export async function createDispensation(payload, userId) {
  return withTransaction(async (connection) => {
    const [warehouseRows] = await connection.execute(
      `SELECT a.*, s.nombre AS sede
       FROM almacenes a
       INNER JOIN sedes s ON s.id_sede = a.id_sede
       WHERE a.id_almacen = ?`,
      [payload.id_almacen]
    );
    const warehouse = warehouseRows[0];

    if (!warehouse) {
      throw new HttpError(404, 'Almacén de dispensación no encontrado');
    }

    if (Number(warehouse.id_sede) !== Number(payload.id_sede)) {
      throw new HttpError(400, 'El almacén no pertenece a la sede seleccionada');
    }

    const patientId = await ensurePatient(connection, payload.paciente);
    const consecutive = payload.consecutivo?.trim() || await nextConsecutive(connection);

    let domiciliary = null;
    if (payload.usar_domiciliario_receptor && payload.id_domiciliario) {
      const [domRows] = await connection.execute(
        `SELECT * FROM domiciliarios WHERE id_domiciliario = ? AND activo = TRUE`,
        [payload.id_domiciliario]
      );
      domiciliary = domRows[0] ?? null;
      if (!domiciliary) {
        throw new HttpError(404, 'Domiciliario no encontrado o inactivo');
      }
    }

    const receptorNombre = payload.usar_domiciliario_receptor && domiciliary
      ? `${domiciliary.nombre} ${domiciliary.apellido}`
      : payload.receptor_nombre;
    const receptorDocumento = payload.usar_domiciliario_receptor && domiciliary
      ? domiciliary.cedula
      : (payload.receptor_documento ?? null);
    const receptorTelefono = payload.usar_domiciliario_receptor && domiciliary
      ? domiciliary.telefono
      : (payload.receptor_telefono ?? null);

    const [headerResult] = await connection.execute(
      `INSERT INTO dispensaciones (
        consecutivo, id_sede, id_almacen, id_usuario, id_paciente, id_solicitud_dispensacion, id_domiciliario,
        usar_domiciliario_receptor, receptor_tipo, receptor_nombre, receptor_documento,
        receptor_telefono, direccion_entrega, observaciones, firma_tipo, firma_nombre, firma_data_url, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'entregada')`,
      [
        consecutive,
        payload.id_sede,
        payload.id_almacen,
        userId ?? null,
        patientId,
        payload.id_solicitud_dispensacion ?? null,
        payload.id_domiciliario ?? null,
        payload.usar_domiciliario_receptor ?? false,
        payload.receptor_tipo ?? 'paciente',
        receptorNombre,
        receptorDocumento,
        receptorTelefono,
        payload.paciente.direccion,
        payload.observaciones ?? null,
        payload.firma.tipo,
        payload.firma.nombre,
        payload.firma.data_url
      ]
    );

    const detailSummary = [];

    for (const item of payload.items) {
      const [stockRows] = await connection.execute(
        `SELECT
            e.id_existencia,
            e.id_almacen,
            e.id_ubicacion,
            e.cantidad_disponible,
            l.id_lote,
            l.numero_lote,
            l.costo_unitario,
            p.id_producto,
            p.nombre_comercial,
            p.principio_activo,
            p.concentracion,
            p.tipo_producto,
            p.requiere_cadena_frio,
            p.es_controlado,
            p.mx_control
         FROM existencias e
         INNER JOIN lotes l ON l.id_lote = e.id_lote
         INNER JOIN productos p ON p.id_producto = l.id_producto
         WHERE e.id_lote = ? AND e.id_almacen = ?
         ORDER BY e.cantidad_disponible DESC
         LIMIT 1
         FOR UPDATE`,
        [item.id_lote, payload.id_almacen]
      );

      const stock = stockRows[0];
      if (!stock) {
        throw new HttpError(404, `No hay existencias disponibles para el lote ${item.id_lote} en el almacén seleccionado`);
      }

      if (toNumber(stock.cantidad_disponible) < toNumber(item.cantidad)) {
        throw new HttpError(400, `Stock insuficiente para ${stock.nombre_comercial} (${stock.numero_lote})`);
      }

      if (Boolean(stock.requiere_cadena_frio) && (item.temperatura_entrega === null || item.temperatura_entrega === undefined)) {
        throw new HttpError(400, `Debes registrar la temperatura de entrega para ${stock.nombre_comercial}`);
      }

      await connection.execute(
        `UPDATE existencias
         SET cantidad_disponible = cantidad_disponible - ?
         WHERE id_existencia = ?`,
        [item.cantidad, stock.id_existencia]
      );

      await connection.execute(
        `INSERT INTO dispensaciones_detalle (
          id_dispensacion, id_producto, id_lote, cantidad, temperatura_entrega,
          requiere_cadena_frio, nombre_comercial, principio_activo, concentracion,
          tipo_producto, es_controlado
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          headerResult.insertId,
          stock.id_producto,
          stock.id_lote,
          item.cantidad,
          item.temperatura_entrega ?? null,
          stock.requiere_cadena_frio,
          stock.nombre_comercial,
          stock.principio_activo ?? null,
          stock.concentracion ?? null,
          stock.tipo_producto ?? null,
          stock.es_controlado
        ]
      );

      await connection.execute(
        `INSERT INTO movimientos_inventario (
          tipo, id_producto, id_lote, id_almacen_origen, id_ubicacion_origen,
          cantidad, costo_unitario, motivo, referencia_tipo, referencia_id, id_usuario
        ) VALUES (
          'salida_venta', ?, ?, ?, ?, ?, ?, ?, 'DISPENSACION', ?, ?
        )`,
        [
          stock.id_producto,
          stock.id_lote,
          stock.id_almacen,
          stock.id_ubicacion,
          item.cantidad,
          stock.costo_unitario,
          'Salida por dispensación',
          headerResult.insertId,
          userId ?? null
        ]
      );

      if (stock.es_controlado) {
        const saldoAnterior = toNumber(stock.cantidad_disponible);
        const saldoNuevo = saldoAnterior - toNumber(item.cantidad);

        await connection.execute(
          `INSERT INTO controlados_libro (
            tipo_movimiento, id_producto, id_lote, cantidad, saldo_anterior, saldo_nuevo,
            referencia_tipo, referencia_id, receta_folio, usuario_responsable, observaciones
          ) VALUES (
            'salida', ?, ?, ?, ?, ?, 'DISPENSACION', ?, ?, ?, ?
          )`,
          [
            stock.id_producto,
            stock.id_lote,
            item.cantidad,
            saldoAnterior,
            saldoNuevo,
            headerResult.insertId,
            payload.receta_folio ?? null,
            userId ?? null,
            'Dispensación de medicamento controlado'
          ]
        );
      }

      detailSummary.push({
        id_lote: stock.id_lote,
        numero_lote: stock.numero_lote,
        id_producto: stock.id_producto,
        nombre_comercial: stock.nombre_comercial,
        principio_activo: stock.principio_activo,
        concentracion: stock.concentracion,
        cantidad: item.cantidad,
        requiere_cadena_frio: Boolean(stock.requiere_cadena_frio),
        temperatura_entrega: item.temperatura_entrega ?? null,
        es_controlado: Boolean(stock.es_controlado)
      });
    }


await recordProcessTrace(connection, {
  proceso: 'DISPENSACION',
  subproceso: 'ENTREGA_FINAL',
  id_sede: payload.id_sede,
  id_usuario: userId ?? null,
  referencia_tipo: 'DISPENSACION',
  referencia_id: headerResult.insertId,
  descripcion: `Dispensación ${consecutive} entregada`,
  payload_json: {
    items: detailSummary.length,
    id_almacen: payload.id_almacen,
    id_solicitud_dispensacion: payload.id_solicitud_dispensacion ?? null
  }
});

return {
  id_dispensacion: headerResult.insertId,
      consecutivo: consecutive,
      paciente_id: patientId,
      receptor_nombre: receptorNombre,
      items: detailSummary
    };
  });
}
