import { query, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';
import { recordProcessTrace } from './traceability.service.js';

function toJson(value) {
  return value ? JSON.stringify(value) : null;
}

async function getExistencia(connection, idLote, idUbicacion) {
  const [rows] = await connection.execute(
    `SELECT * FROM existencias WHERE id_lote = ? AND id_ubicacion = ? FOR UPDATE`,
    [idLote, idUbicacion]
  );
  return rows[0];
}

async function getProductByBarcodeWithConnection(connection, barcode) {
  const [rows] = await connection.execute(
    `SELECT
        p.id_producto,
        p.sku,
        p.codigo_barras,
        p.nombre_comercial,
        p.principio_activo,
        p.concentracion,
        p.tipo_producto,
        p.requiere_receta,
        p.es_controlado,
        p.requiere_cadena_frio,
        p.costo_referencia,
        p.precio_venta,
        p.stock_minimo,
        (
          SELECT CONCAT(?, '/', pi.url_relativa)
          FROM productos_imagenes pi
          WHERE pi.id_producto = p.id_producto
          ORDER BY pi.es_principal DESC, pi.fecha_creacion DESC
          LIMIT 1
        ) AS imagen_principal_url
     FROM productos p
     WHERE p.codigo_barras = ? AND p.activo = TRUE
     LIMIT 1`,
    [env.PUBLIC_UPLOAD_BASE_URL, barcode]
  );

  return rows[0] ?? null;
}

async function getAvailableLotsByProduct(connection, idProducto) {
  const [rows] = await connection.execute(
    `SELECT
        l.id_lote,
        l.numero_lote,
        l.fecha_vencimiento,
        l.estado,
        e.id_almacen,
        e.id_ubicacion,
        a.nombre AS almacen,
        a.tipo AS tipo_almacen,
        u.nombre AS ubicacion,
        u.tipo AS tipo_ubicacion,
        ROUND(COALESCE(e.cantidad_disponible, 0), 3) AS cantidad_disponible,
        DATEDIFF(l.fecha_vencimiento, CURRENT_DATE()) AS dias_para_vencer
     FROM lotes l
     INNER JOIN existencias e ON e.id_lote = l.id_lote
     INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
     INNER JOIN ubicaciones_almacen u ON u.id_ubicacion = e.id_ubicacion
     WHERE l.id_producto = ?
       AND COALESCE(e.cantidad_disponible, 0) > 0
     ORDER BY l.fecha_vencimiento ASC, e.cantidad_disponible DESC`,
    [idProducto]
  );

  return rows;
}

async function recordBarcodeScan(connection, payload) {
  const [result] = await connection.execute(
    `INSERT INTO escaneos_codigo_barras (
      modo, fuente, canal_lectura, tipo_scanner, forma_uso, scanner_label, scanner_vendor_id, scanner_product_id,
      codigo_barras, id_producto, id_lote, id_movimiento,
      resultado, mensaje, cantidad, metadata, id_usuario
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.modo,
      payload.fuente,
      payload.canal_lectura ?? 'unknown',
      payload.tipo_scanner ?? 'desconocido',
      payload.forma_uso ?? 'desconocida',
      payload.scanner_label ?? null,
      payload.scanner_vendor_id ?? null,
      payload.scanner_product_id ?? null,
      payload.codigo_barras,
      payload.id_producto ?? null,
      payload.id_lote ?? null,
      payload.id_movimiento ?? null,
      payload.resultado ?? 'resuelto',
      payload.mensaje ?? null,
      payload.cantidad ?? null,
      toJson(payload.metadata),
      payload.id_usuario ?? null
    ]
  );

  return result.insertId;
}

async function getLocationById(connection, idUbicacion) {
  const [rows] = await connection.execute(
    `SELECT u.id_ubicacion, u.id_almacen, u.nombre AS ubicacion, u.tipo AS tipo_ubicacion,
            a.nombre AS almacen, a.tipo AS tipo_almacen
     FROM ubicaciones_almacen u
     INNER JOIN almacenes a ON a.id_almacen = u.id_almacen
     WHERE u.id_ubicacion = ?`,
    [idUbicacion]
  );

  return rows[0] ?? null;
}

export async function listStock(search = '') {
  const wildcard = `%${search}%`;

  return query(
    `SELECT
        p.id_producto,
        p.sku,
        p.codigo_barras,
        p.nombre_comercial,
        l.id_lote,
        l.numero_lote,
        l.fecha_vencimiento,
        a.nombre AS almacen,
        a.tipo AS tipo_almacen,
        u.nombre AS ubicacion,
        u.tipo AS tipo_ubicacion,
        COALESCE(e.cantidad_disponible, 0) AS cantidad_disponible,
        COALESCE(e.cantidad_reservada, 0) AS cantidad_reservada,
        COALESCE(e.cantidad_cuarentena, 0) AS cantidad_cuarentena,
        COALESCE(l.costo_unitario, 0) AS costo_unitario,
        COALESCE(l.precio_venta, 0) AS precio_venta,
        DATEDIFF(l.fecha_vencimiento, CURRENT_DATE()) AS dias_para_vencer
     FROM existencias e
     INNER JOIN lotes l ON l.id_lote = e.id_lote
     INNER JOIN productos p ON p.id_producto = l.id_producto
     INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
     INNER JOIN ubicaciones_almacen u ON u.id_ubicacion = e.id_ubicacion
     WHERE (? = '' OR p.nombre_comercial LIKE ? OR p.sku LIKE ? OR p.codigo_barras LIKE ? OR l.numero_lote LIKE ?)
     ORDER BY p.nombre_comercial, l.fecha_vencimiento ASC`,
    [search, wildcard, wildcard, wildcard, wildcard]
  );
}

export async function getInventoryLookups() {
  const almacenes = await query(
    `SELECT id_almacen, codigo, nombre, tipo FROM almacenes WHERE activo = TRUE ORDER BY es_principal DESC, nombre ASC`
  );

  const ubicaciones = await query(
    `SELECT u.id_ubicacion, u.id_almacen, u.codigo, u.nombre, u.tipo, u.permite_controlados,
            u.requiere_cadena_frio, a.nombre AS almacen, a.tipo AS tipo_almacen
     FROM ubicaciones_almacen u
     INNER JOIN almacenes a ON a.id_almacen = u.id_almacen
     WHERE u.activo = TRUE
     ORDER BY a.nombre ASC, u.nombre ASC`
  );

  return {
    almacenes,
    ubicaciones,
    tipos_egreso: ['salida_venta', 'merma', 'devolucion_compra', 'destruccion']
  };
}

export async function listRecentBarcodeScans(limit = 12) {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  return query(
    `SELECT
        s.id_escaneo,
        s.fecha_hora,
        s.modo,
        s.fuente,
        s.codigo_barras,
        s.resultado,
        s.mensaje,
        s.cantidad,
        p.sku,
        p.nombre_comercial,
        l.numero_lote
     FROM escaneos_codigo_barras s
     LEFT JOIN productos p ON p.id_producto = s.id_producto
     LEFT JOIN lotes l ON l.id_lote = s.id_lote
     ORDER BY s.fecha_hora DESC
     LIMIT ${safeLimit}`
  );
}

export async function resolveBarcode(payload, userId) {
  return withTransaction(async (connection) => {
    const product = await getProductByBarcodeWithConnection(connection, payload.barcode);

    if (!product) {
      await recordBarcodeScan(connection, {
        modo: payload.mode ?? 'consulta',
        fuente: payload.source ?? 'lector',
        codigo_barras: payload.barcode,
        resultado: 'no_encontrado',
        mensaje: 'Código no asociado a un producto activo',
        id_usuario: userId ?? null
      });

      return {
        found: false,
        barcode: payload.barcode,
        message: 'Código no asociado a un producto activo',
        product: null,
        lots: [],
        stock_total: 0
      };
    }

    const lots = await getAvailableLotsByProduct(connection, product.id_producto);
    const stockTotal = lots.reduce((accumulator, item) => accumulator + Number(item.cantidad_disponible ?? 0), 0);

    await recordBarcodeScan(connection, {
      modo: payload.mode ?? 'consulta',
      fuente: payload.source ?? 'lector',
      codigo_barras: payload.barcode,
      id_producto: product.id_producto,
      resultado: 'resuelto',
      mensaje: 'Código resuelto correctamente',
      metadata: {
        stock_total: stockTotal,
        lots_available: lots.length
      },
      id_usuario: userId ?? null
    });

    return {
      found: true,
      barcode: payload.barcode,
      product,
      lots,
      stock_total: stockTotal,
      suggested_lot_id: lots[0]?.id_lote ?? null,
      suggested_location_id: lots[0]?.id_ubicacion ?? null
    };
  });
}

export async function registerBarcodeIngress(payload, userId) {
  return withTransaction(async (connection) => {
    const product = await getProductByBarcodeWithConnection(connection, payload.barcode);
    if (!product) {
      throw new HttpError(404, 'No existe un producto activo para el código de barras indicado');
    }

    const location = await getLocationById(connection, payload.id_ubicacion_destino);
    if (!location) {
      throw new HttpError(404, 'Ubicación destino no encontrada');
    }

    let loteId;
    let loteNumero = payload.numero_lote;

    const [lotRows] = await connection.execute(
      `SELECT id_lote, numero_lote
       FROM lotes
       WHERE id_producto = ? AND numero_lote = ?
       LIMIT 1`,
      [product.id_producto, payload.numero_lote]
    );

    if (lotRows[0]) {
      loteId = lotRows[0].id_lote;
      loteNumero = lotRows[0].numero_lote;
    } else {
      const [lotInsert] = await connection.execute(
        `INSERT INTO lotes (
          id_producto, id_proveedor, numero_lote, fecha_fabricacion, fecha_vencimiento,
          registro_sanitario, estado, costo_unitario, precio_venta
        ) VALUES (?, ?, ?, ?, ?, ?, 'disponible', ?, ?)`,
        [
          product.id_producto,
          payload.id_proveedor ?? null,
          payload.numero_lote,
          payload.fecha_fabricacion ?? null,
          payload.fecha_vencimiento,
          payload.registro_sanitario ?? null,
          payload.costo_unitario ?? product.costo_referencia ?? 0,
          payload.precio_venta ?? product.precio_venta ?? 0
        ]
      );
      loteId = lotInsert.insertId;
    }

    const existencia = await getExistencia(connection, loteId, payload.id_ubicacion_destino);

    if (existencia) {
      await connection.execute(
        `UPDATE existencias
         SET cantidad_disponible = cantidad_disponible + ?
         WHERE id_existencia = ?`,
        [payload.quantity, existencia.id_existencia]
      );
    } else {
      await connection.execute(
        `INSERT INTO existencias (id_lote, id_almacen, id_ubicacion, cantidad_disponible)
         VALUES (?, ?, ?, ?)`,
        [loteId, location.id_almacen, location.id_ubicacion, payload.quantity]
      );
    }

    const [movementInsert] = await connection.execute(
      `INSERT INTO movimientos_inventario (
        tipo, id_producto, id_lote, id_almacen_destino, id_ubicacion_destino,
        cantidad, costo_unitario, motivo, referencia_tipo, referencia_id, id_usuario
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'entrada_compra',
        product.id_producto,
        loteId,
        location.id_almacen,
        location.id_ubicacion,
        payload.quantity,
        payload.costo_unitario ?? product.costo_referencia ?? 0,
        payload.motivo ?? 'Ingreso por escaneo de código de barras',
        payload.referencia_tipo ?? 'barcode_ingress',
        payload.referencia_id ?? null,
        userId ?? null
      ]
    );

    const scanId = await recordBarcodeScan(connection, {
      modo: 'ingreso',
      fuente: payload.source ?? 'lector',
      codigo_barras: payload.barcode,
      id_producto: product.id_producto,
      id_lote: loteId,
      id_movimiento: movementInsert.insertId,
      cantidad: payload.quantity,
      resultado: 'resuelto',
      mensaje: 'Ingreso registrado por escaneo',
      metadata: {
        numero_lote: loteNumero,
        id_ubicacion_destino: location.id_ubicacion,
        id_almacen_destino: location.id_almacen
      },
      id_usuario: userId ?? null
    });

    return {
      id_movimiento: movementInsert.insertId,
      id_escaneo: scanId,
      product,
      lote: {
        id_lote: loteId,
        numero_lote: loteNumero,
        fecha_vencimiento: payload.fecha_vencimiento
      },
      destination: location,
      quantity: payload.quantity,
      message: 'Ingreso registrado correctamente mediante código de barras'
    };
  });
}

export async function registerBarcodeEgress(payload, userId) {
  return withTransaction(async (connection) => {
    const product = await getProductByBarcodeWithConnection(connection, payload.barcode);
    if (!product) {
      throw new HttpError(404, 'No existe un producto activo para el código de barras indicado');
    }

    const params = [product.id_producto];
    let sql = `SELECT
        e.id_existencia,
        e.id_almacen,
        e.id_ubicacion,
        e.cantidad_disponible,
        l.id_lote,
        l.numero_lote,
        l.fecha_vencimiento,
        l.costo_unitario,
        a.nombre AS almacen,
        u.nombre AS ubicacion
      FROM existencias e
      INNER JOIN lotes l ON l.id_lote = e.id_lote
      INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
      INNER JOIN ubicaciones_almacen u ON u.id_ubicacion = e.id_ubicacion
      WHERE l.id_producto = ?
        AND COALESCE(e.cantidad_disponible, 0) > 0`;

    if (payload.id_lote) {
      sql += ' AND l.id_lote = ?';
      params.push(payload.id_lote);
    }

    if (payload.id_ubicacion_origen) {
      sql += ' AND e.id_ubicacion = ?';
      params.push(payload.id_ubicacion_origen);
    }

    sql += ' ORDER BY l.fecha_vencimiento ASC, e.cantidad_disponible DESC LIMIT 1 FOR UPDATE';

    const [availabilityRows] = await connection.execute(sql, params);
    const availability = availabilityRows[0];

    if (!availability) {
      throw new HttpError(400, 'No hay stock disponible para el código escaneado en la selección indicada');
    }

    const nextValue = Number(availability.cantidad_disponible) - Number(payload.quantity);
    if (!env.ALLOW_STOCK_NEGATIVE && nextValue < 0) {
      throw new HttpError(400, 'Stock insuficiente para registrar el egreso solicitado');
    }

    await connection.execute(
      `UPDATE existencias
       SET cantidad_disponible = cantidad_disponible - ?
       WHERE id_existencia = ?`,
      [payload.quantity, availability.id_existencia]
    );

    const [movementInsert] = await connection.execute(
      `INSERT INTO movimientos_inventario (
        tipo, id_producto, id_lote, id_almacen_origen, id_ubicacion_origen,
        cantidad, costo_unitario, motivo, referencia_tipo, referencia_id, id_usuario
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.tipo_egreso ?? 'salida_venta',
        product.id_producto,
        availability.id_lote,
        availability.id_almacen,
        availability.id_ubicacion,
        payload.quantity,
        availability.costo_unitario ?? product.costo_referencia ?? 0,
        payload.motivo ?? 'Egreso por escaneo de código de barras',
        payload.referencia_tipo ?? 'barcode_egress',
        payload.referencia_id ?? null,
        userId ?? null
      ]
    );

    const scanId = await recordBarcodeScan(connection, {
      modo: 'egreso',
      fuente: payload.source ?? 'lector',
      codigo_barras: payload.barcode,
      id_producto: product.id_producto,
      id_lote: availability.id_lote,
      id_movimiento: movementInsert.insertId,
      cantidad: payload.quantity,
      resultado: 'resuelto',
      mensaje: 'Egreso registrado por escaneo',
      metadata: {
        numero_lote: availability.numero_lote,
        id_ubicacion_origen: availability.id_ubicacion,
        id_almacen_origen: availability.id_almacen,
        saldo_resultante: Number(availability.cantidad_disponible) - Number(payload.quantity)
      },
      id_usuario: userId ?? null
    });

    return {
      id_movimiento: movementInsert.insertId,
      id_escaneo: scanId,
      product,
      lote: {
        id_lote: availability.id_lote,
        numero_lote: availability.numero_lote,
        fecha_vencimiento: availability.fecha_vencimiento
      },
      origin: {
        id_almacen: availability.id_almacen,
        almacen: availability.almacen,
        id_ubicacion: availability.id_ubicacion,
        ubicacion: availability.ubicacion
      },
      quantity: payload.quantity,
      remaining_quantity: Math.max(0, Number(availability.cantidad_disponible) - Number(payload.quantity)),
      message: 'Egreso registrado correctamente mediante código de barras'
    };
  });
}

export async function createMovement(payload, userId) {
  return withTransaction(async (connection) => {
    const [loteRows] = await connection.execute(
      `SELECT l.*, p.id_producto
       FROM lotes l
       INNER JOIN productos p ON p.id_producto = l.id_producto
       WHERE l.id_lote = ?`,
      [payload.id_lote]
    );
    const lote = loteRows[0];

    if (!lote) {
      throw new HttpError(404, 'Lote no encontrado');
    }

    const debitOriginTypes = ['salida_venta', 'merma', 'destruccion', 'cuarentena', 'traslado', 'devolucion_compra'];
    const creditDestinationTypes = ['entrada_compra', 'traslado', 'devolucion_venta', 'liberacion'];

    if (debitOriginTypes.includes(payload.tipo)) {
      if (!payload.id_ubicacion_origen) {
        throw new HttpError(400, 'La ubicación de origen es obligatoria para este movimiento');
      }

      const existencia = await getExistencia(connection, payload.id_lote, payload.id_ubicacion_origen);

      if (!existencia) {
        throw new HttpError(400, 'No existe saldo para el lote y ubicación de origen');
      }

      const nextValue = Number(existencia.cantidad_disponible) - Number(payload.cantidad);

      if (!env.ALLOW_STOCK_NEGATIVE && nextValue < 0) {
        throw new HttpError(400, 'Stock insuficiente para el movimiento');
      }

      await connection.execute(
        `UPDATE existencias
         SET cantidad_disponible = cantidad_disponible - ?
         WHERE id_existencia = ?`,
        [payload.cantidad, existencia.id_existencia]
      );
    }

    if (payload.id_ubicacion_destino && creditDestinationTypes.includes(payload.tipo)) {
      const [existingRows] = await connection.execute(
        `SELECT * FROM existencias WHERE id_lote = ? AND id_ubicacion = ? FOR UPDATE`,
        [payload.id_lote, payload.id_ubicacion_destino]
      );

      if (existingRows[0]) {
        await connection.execute(
          `UPDATE existencias
           SET cantidad_disponible = cantidad_disponible + ?
           WHERE id_existencia = ?`,
          [payload.cantidad, existingRows[0].id_existencia]
        );
      } else {
        const [ubicacionRows] = await connection.execute(
          `SELECT id_almacen FROM ubicaciones_almacen WHERE id_ubicacion = ?`,
          [payload.id_ubicacion_destino]
        );
        const ubicacion = ubicacionRows[0];

        await connection.execute(
          `INSERT INTO existencias (id_lote, id_almacen, id_ubicacion, cantidad_disponible)
           VALUES (?, ?, ?, ?)`,
          [payload.id_lote, ubicacion.id_almacen, payload.id_ubicacion_destino, payload.cantidad]
        );
      }
    }

    const [result] = await connection.execute(
      `INSERT INTO movimientos_inventario (
        tipo, id_producto, id_lote, id_almacen_origen, id_ubicacion_origen,
        id_almacen_destino, id_ubicacion_destino, cantidad, costo_unitario, motivo,
        referencia_tipo, referencia_id, id_usuario
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.tipo,
        lote.id_producto,
        payload.id_lote,
        payload.id_almacen_origen ?? null,
        payload.id_ubicacion_origen ?? null,
        payload.id_almacen_destino ?? null,
        payload.id_ubicacion_destino ?? null,
        payload.cantidad,
        payload.costo_unitario ?? lote.costo_unitario,
        payload.motivo ?? null,
        payload.referencia_tipo ?? null,
        payload.referencia_id ?? null,
        userId ?? null
      ]
    );


await recordProcessTrace(connection, {
  proceso: 'INVENTARIO',
  subproceso: 'MOVIMIENTO_MANUAL',
  id_sede: payload.id_sede ?? null,
  id_usuario: userId ?? null,
  referencia_tipo: 'MOVIMIENTO_INVENTARIO',
  referencia_id: result.insertId,
  descripcion: `Movimiento ${payload.tipo} registrado`,
  payload_json: { tipo: payload.tipo, cantidad: payload.cantidad, id_lote: payload.id_lote }
});

return {
  id_movimiento: result.insertId,
  message: 'Movimiento registrado correctamente'
};

  });
}


export async function resolveBarcodeForLegacyLookup(barcode, userId, source = 'manual') {
  const data = await resolveBarcode({ barcode, mode: 'consulta', source }, userId);
  const suggestedLot = data.lots?.[0]
    ? {
        id_lote: data.lots[0].id_lote,
        numero_lote: data.lots[0].numero_lote,
        fecha_vencimiento: data.lots[0].fecha_vencimiento,
        cantidad_disponible: data.lots[0].cantidad_disponible,
        id_almacen: data.lots[0].id_almacen,
        id_ubicacion: data.lots[0].id_ubicacion,
        almacen: data.lots[0].almacen,
        ubicacion: data.lots[0].ubicacion,
        precio_venta: data.product?.precio_venta ?? null
      }
    : null;

  return {
    ...data,
    suggestedLot,
    suggestedLocationId: data.suggested_location_id ?? suggestedLot?.id_ubicacion ?? null,
    suggestedLotId: data.suggested_lot_id ?? suggestedLot?.id_lote ?? null
  };
}



export async function getInventorySummary(scope = 'general', siteId = null, search = '') {
  const wildcard = `%${search}%`;
  if (scope === 'local' && siteId) {
    return query(
      `SELECT *
       FROM vw_inventario_local_sede
       WHERE id_sede = ?
         AND (? = '' OR nombre_comercial LIKE ? OR sku LIKE ? OR codigo_barras LIKE ?)
       ORDER BY nombre_comercial ASC`,
      [siteId, search, wildcard, wildcard, wildcard]
    );
  }
  return query(
    `SELECT *
     FROM vw_inventario_general
     WHERE (? = '' OR nombre_comercial LIKE ? OR sku LIKE ? OR codigo_barras LIKE ?)
     ORDER BY nombre_comercial ASC`,
    [search, wildcard, wildcard, wildcard]
  );
}

export async function getInventoryBySite(search = '') {
  const wildcard = `%${search}%`;
  return query(
    `SELECT *
     FROM vw_inventario_local_sede
     WHERE (? = '' OR nombre_comercial LIKE ? OR sku LIKE ? OR codigo_barras LIKE ?)
     ORDER BY sede_nombre ASC, nombre_comercial ASC`,
    [search, wildcard, wildcard, wildcard]
  );
}
