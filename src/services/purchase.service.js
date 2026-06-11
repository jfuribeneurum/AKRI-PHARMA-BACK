import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';
import { recordProcessTrace } from './traceability.service.js';

function calculateTotals(items) {
  return items.reduce((acc, item) => {
    const subtotalLinea = Number(item.cantidad) * Number(item.precio_unitario);
    const descuento = Number(item.descuento ?? 0);
    const impuesto = Number(item.impuesto ?? 0);
    acc.subtotal += subtotalLinea - descuento;
    acc.impuestos += impuesto;
    acc.total += subtotalLinea - descuento + impuesto;
    return acc;
  }, { subtotal: 0, impuestos: 0, total: 0 });
}

async function getActiveSite(idSede) {
  if (!idSede) return null;
  const rows = await query(
    `SELECT id_sede, codigo, nombre, es_principal, activo
       FROM sedes
      WHERE id_sede = ?
      LIMIT 1`,
    [idSede]
  );
  return rows[0] ?? null;
}

async function assertCentralPurchasing(user) {
  const site = await getActiveSite(user?.id_sede);
  if (!site || !site.activo) {
    throw new HttpError(400, 'La sesión no tiene una sede activa válida');
  }
  if (!site.es_principal) {
    throw new HttpError(403, 'Las órdenes de compra solo se gestionan desde la sede central');
  }
  return site;
}

export async function listPurchases(user = null) {
  const site = user?.id_sede ? await getActiveSite(user.id_sede) : null;
  const params = [];
  let siteFilter = '';
  if (site && !site.es_principal) {
    siteFilter = 'WHERE oc.id_sede = ?';
    params.push(site.id_sede);
  }

  return query(
    `SELECT oc.*, COALESCE(p.razon_social, p.nombre) AS proveedor, s.nombre AS sede
       FROM ordenes_compra oc
       INNER JOIN proveedores p ON p.id_proveedor = oc.id_proveedor
       LEFT JOIN sedes s ON s.id_sede = oc.id_sede
       ${siteFilter}
      ORDER BY oc.id_oc DESC`,
    params
  );
}

function buildNextFromRow(row) {
  if (!row) return 'OC-0000001';
  const seq = parseInt(row.numero_oc.slice(3), 10);
  return `OC-${String(seq + 1).padStart(7, '0')}`;
}

async function nextNumeroOC(connection) {
  const [rows] = await connection.execute(
    `SELECT numero_oc FROM ordenes_compra
     WHERE numero_oc REGEXP '^OC-[0-9]+$'
     ORDER BY CAST(SUBSTRING(numero_oc, 4) AS UNSIGNED) DESC
     LIMIT 1
     FOR UPDATE`
  );
  return buildNextFromRow(rows[0]);
}

export async function listWarehousesForPO() {
  return query(
    `SELECT a.id_almacen, a.codigo, a.nombre, a.tipo,
            s.id_sede, s.nombre AS sede_nombre, s.ciudad AS sede_ciudad, s.direccion AS sede_direccion
       FROM almacenes a
       INNER JOIN sedes s ON s.id_sede = a.id_sede
      WHERE a.activo = TRUE AND s.activo = TRUE
      ORDER BY s.es_principal DESC, s.nombre ASC, a.es_principal DESC, a.nombre ASC`
  );
}

export async function previewNextNumeroOC() {
  const rows = await query(
    `SELECT numero_oc FROM ordenes_compra
     WHERE numero_oc REGEXP '^OC-[0-9]+$'
     ORDER BY CAST(SUBSTRING(numero_oc, 4) AS UNSIGNED) DESC
     LIMIT 1`
  );
  return buildNextFromRow(rows[0]);
}

export async function createPurchaseOrder(payload, user) {
  const site = await assertCentralPurchasing(user);
  return withTransaction(async (connection) => {
    const numero_oc = await nextNumeroOC(connection);
    const totals = calculateTotals(payload.items);
    const [headerResult] = await connection.execute(
      `INSERT INTO ordenes_compra (
        id_sede, numero_oc, fecha, id_proveedor, estado, subtotal, impuestos, total, observaciones, creado_por
      ) VALUES (?, ?, CURRENT_DATE(), ?, ?, ?, ?, ?, ?, ?)`,
      [
        site.id_sede,
        numero_oc,
        payload.id_proveedor,
        payload.estado ?? 'borrador',
        totals.subtotal,
        totals.impuestos,
        totals.total,
        payload.observaciones ?? null,
        user?.sub ?? null
      ]
    );

    for (const item of payload.items) {
      await connection.execute(
        `INSERT INTO ordenes_compra_detalle (
          id_oc, id_producto, cantidad, precio_unitario, precio_venta, costo_referencia, descuento, impuesto, fecha_requerida
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          headerResult.insertId,
          item.id_producto,
          item.cantidad,
          item.precio_unitario,
          item.precio_venta ?? 0,
          item.costo_referencia ?? 0,
          item.descuento ?? 0,
          item.impuesto ?? 0,
          item.fecha_requerida ?? null
        ]
      );
    }

    await recordProcessTrace(connection, {
      proceso: 'COMPRAS',
      subproceso: 'ORDEN_COMPRA',
      id_sede: site.id_sede,
      id_usuario: user?.sub ?? null,
      perfil_nombre: user?.role ?? null,
      referencia_tipo: 'ORDEN_COMPRA',
      referencia_id: headerResult.insertId,
      descripcion: `OC ${numero_oc} creada desde sede central`,
      payload_json: { items: payload.items.length, total: totals.total }
    });

    return {
      id_oc: headerResult.insertId,
      numero_oc: payload.numero_oc,
      id_sede: site.id_sede,
      sede: site.nombre,
      ...totals
    };
  });
}

export async function receivePurchaseOrder(idOc, payload, user) {
  const site = await assertCentralPurchasing(user);
  return withTransaction(async (connection) => {
    const [ocRows] = await connection.execute(
      `SELECT * FROM ordenes_compra WHERE id_oc = ? FOR UPDATE`,
      [idOc]
    );
    const oc = ocRows[0];

    if (!oc) {
      throw new HttpError(404, 'Orden de compra no encontrada');
    }

    if (Number(oc.id_sede) !== Number(site.id_sede)) {
      throw new HttpError(403, 'La orden de compra pertenece a otra sede');
    }

    const [recepResult] = await connection.execute(
      `INSERT INTO recepciones_compra (
        id_oc, id_almacen, id_usuario, numero_factura_proveedor, observaciones
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        idOc,
        payload.id_almacen,
        user?.sub ?? null,
        payload.numero_factura_proveedor ?? null,
        payload.observaciones ?? null
      ]
    );

    const [ubicacionRows] = await connection.execute(
      `SELECT id_ubicacion FROM ubicaciones_almacen WHERE id_almacen = ? ORDER BY id_ubicacion ASC LIMIT 1`,
      [payload.id_almacen]
    );
    const ubicacion = ubicacionRows[0];

    if (!ubicacion) {
      throw new HttpError(400, 'El almacén no tiene ubicaciones configuradas');
    }

    // Leer precio_venta y costo_referencia definidos en la orden de compra
    const [ocDetailRows] = await connection.execute(
      `SELECT id_producto, precio_venta, costo_referencia FROM ordenes_compra_detalle WHERE id_oc = ?`,
      [idOc]
    );
    const pricesByProduct = new Map(ocDetailRows.map(r => [Number(r.id_producto), r]));

    for (const item of payload.items) {
      const [productRows] = await connection.execute(
        `SELECT * FROM productos WHERE id_producto = ?`,
        [item.id_producto]
      );
      const product = productRows[0];

      if (!product) {
        throw new HttpError(404, `Producto ${item.id_producto} no encontrado`);
      }

      const prices = pricesByProduct.get(Number(item.id_producto)) ?? { precio_venta: 0, costo_referencia: 0 };

      const [loteRows] = await connection.execute(
        `SELECT * FROM lotes WHERE id_producto = ? AND numero_lote = ? FOR UPDATE`,
        [item.id_producto, item.numero_lote]
      );

      let loteId;

      if (loteRows[0]) {
        loteId = loteRows[0].id_lote;
        // Actualizar precio_venta del lote existente si viene de la OC
        if (prices.precio_venta) {
          await connection.execute(
            `UPDATE lotes SET precio_venta = ? WHERE id_lote = ?`,
            [prices.precio_venta, loteId]
          );
        }
      } else {
        const [loteResult] = await connection.execute(
          `INSERT INTO lotes (
            id_producto, id_proveedor, numero_lote, fecha_vencimiento, estado, costo_unitario, precio_venta
          ) VALUES (?, ?, ?, ?, 'disponible', ?, ?)`,
          [
            item.id_producto,
            oc.id_proveedor,
            item.numero_lote,
            item.fecha_vencimiento,
            item.costo_unitario,
            prices.precio_venta
          ]
        );
        loteId = loteResult.insertId;
      }

      // Actualizar precio_venta y costo_referencia en el catálogo del producto
      if (prices.precio_venta || prices.costo_referencia) {
        await connection.execute(
          `UPDATE productos SET precio_venta = ?, costo_referencia = ? WHERE id_producto = ?`,
          [prices.precio_venta, prices.costo_referencia, item.id_producto]
        );
      }

      const [existenciaRows] = await connection.execute(
        `SELECT * FROM existencias WHERE id_lote = ? AND id_ubicacion = ? FOR UPDATE`,
        [loteId, ubicacion.id_ubicacion]
      );

      if (existenciaRows[0]) {
        await connection.execute(
          `UPDATE existencias
           SET cantidad_disponible = cantidad_disponible + ?
           WHERE id_existencia = ?`,
          [item.cantidad_recibida, existenciaRows[0].id_existencia]
        );
      } else {
        await connection.execute(
          `INSERT INTO existencias (id_lote, id_almacen, id_ubicacion, cantidad_disponible)
           VALUES (?, ?, ?, ?)`,
          [loteId, payload.id_almacen, ubicacion.id_ubicacion, item.cantidad_recibida]
        );
      }

      await connection.execute(
        `INSERT INTO recepciones_compra_detalle (
          id_recepcion, id_producto, numero_lote, fecha_vencimiento, cantidad_recibida, costo_unitario, id_lote_creado
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          recepResult.insertId,
          item.id_producto,
          item.numero_lote,
          item.fecha_vencimiento,
          item.cantidad_recibida,
          item.costo_unitario,
          loteId
        ]
      );

      await connection.execute(
        `INSERT INTO movimientos_inventario (
          tipo, id_producto, id_lote, id_almacen_destino, id_ubicacion_destino,
          cantidad, costo_unitario, motivo, referencia_tipo, referencia_id, id_usuario
        ) VALUES (
          'entrada_compra', ?, ?, ?, ?, ?, ?, ?, 'RECEPCION_COMPRA', ?, ?
        )`,
        [
          item.id_producto,
          loteId,
          payload.id_almacen,
          ubicacion.id_ubicacion,
          item.cantidad_recibida,
          item.costo_unitario,
          payload.observaciones ?? 'Recepción de compra',
          recepResult.insertId,
          user?.sub ?? null
        ]
      );
    }

    await connection.execute(
      `UPDATE ordenes_compra
       SET estado = 'recibida_total'
       WHERE id_oc = ?`,
      [idOc]
    );

    await recordProcessTrace(connection, {
      proceso: 'COMPRAS',
      subproceso: 'RECEPCION_ORDEN_COMPRA',
      id_sede: site.id_sede,
      id_usuario: user?.sub ?? null,
      perfil_nombre: user?.role ?? null,
      referencia_tipo: 'ORDEN_COMPRA',
      referencia_id: idOc,
      descripcion: `Recepción de OC ${oc.numero_oc}`,
      payload_json: { items: payload.items.length }
    });

    return {
      id_recepcion: recepResult.insertId,
      message: 'Recepción registrada correctamente',
      sede: site.nombre
    };
  });
}
