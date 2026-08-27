import { query, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';
import { recordProcessTrace } from './traceability.service.js';

function calculateSaleTotals(items) {
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

export async function listSales() {
  return query(
    `SELECT v.*, c.nombre AS cliente, p.nombre AS paciente
     FROM ventas v
     LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
     LEFT JOIN pacientes p ON p.id_paciente = v.id_paciente
     ORDER BY v.id_venta DESC`
  );
}

export async function createSale(payload, userId) {
  return withTransaction(async (connection) => {
    const totals = calculateSaleTotals(payload.items);

    const [headerResult] = await connection.execute(
      `INSERT INTO ventas (
        id_sede, folio_venta, tipo, id_cliente, id_paciente, id_medico, id_receta,
        estado, subtotal, impuestos, total, metodo_pago, requiere_factura, creado_por
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmada', ?, ?, ?, ?, ?, ?)`,
      [
        payload.id_sede,
        payload.folio_venta,
        payload.tipo ?? 'mostrador',
        payload.id_cliente ?? null,
        payload.id_paciente ?? null,
        payload.id_medico ?? null,
        payload.id_receta ?? null,
        totals.subtotal,
        totals.impuestos,
        totals.total,
        payload.metodo_pago ?? 'efectivo',
        payload.requiere_factura ?? false,
        userId ?? null
      ]
    );

    for (const item of payload.items) {
      const [loteRows] = await connection.execute(
        `SELECT
            l.*,
            p.id_producto,
            p.mx_control,
            p.es_controlado,
            p.nombre_comercial,
            e.id_existencia,
            e.id_almacen,
            e.id_ubicacion,
            e.cantidad_disponible
         FROM lotes l
         INNER JOIN productos p ON p.id_producto = l.id_producto
         INNER JOIN existencias e ON e.id_lote = l.id_lote
         WHERE l.id_lote = ?
         FOR UPDATE`,
        [item.id_lote]
      );

      const lote = loteRows[0];

      if (!lote) {
        throw new HttpError(404, `Lote ${item.id_lote} no encontrado`);
      }

      if (lote.mx_control && !payload.id_receta) {
        throw new HttpError(400, `El producto ${lote.nombre_comercial} requiere receta`);
      }

      if (!env.ALLOW_STOCK_NEGATIVE && Number(lote.cantidad_disponible) < Number(item.cantidad)) {
        throw new HttpError(400, `Stock insuficiente para el lote ${lote.numero_lote}`);
      }

      await connection.execute(
        `UPDATE existencias
         SET cantidad_disponible = cantidad_disponible - ?
         WHERE id_existencia = ?`,
        [item.cantidad, lote.id_existencia]
      );

      await connection.execute(
        `INSERT INTO ventas_detalle (
          id_venta, id_producto, id_lote, cantidad, precio_unitario, impuesto, descuento, mx_control, validacion_controlado
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          headerResult.insertId,
          lote.id_producto,
          item.id_lote,
          item.cantidad,
          item.precio_unitario,
          item.impuesto ?? 0,
          item.descuento ?? 0,
          lote.mx_control,
          lote.es_controlado ? JSON.stringify({
            doble_verificacion: Boolean(item.doble_verificacion_por),
            doble_verificacion_por: item.doble_verificacion_por ?? null
          }) : null
        ]
      );

      await connection.execute(
        `INSERT INTO movimientos_inventario (
          tipo, id_producto, id_lote, id_almacen_origen, id_ubicacion_origen,
          cantidad, costo_unitario, motivo, referencia_tipo, referencia_id, id_usuario
        ) VALUES (
          'salida_venta', ?, ?, ?, ?, ?, ?, ?, 'VENTA', ?, ?
        )`,
        [
          lote.id_producto,
          item.id_lote,
          lote.id_almacen,
          lote.id_ubicacion,
          item.cantidad,
          lote.costo_unitario,
          'Salida por venta',
          headerResult.insertId,
          userId ?? null
        ]
      );

      if (lote.es_controlado) {
        const saldoAnterior = Number(lote.cantidad_disponible);
        const saldoNuevo = saldoAnterior - Number(item.cantidad);

        await connection.execute(
          `INSERT INTO controlados_libro (
            tipo_movimiento, id_producto, id_lote, cantidad, saldo_anterior, saldo_nuevo,
            referencia_tipo, referencia_id, receta_folio, usuario_responsable, doble_verificacion_por, observaciones
          ) VALUES (
            'salida', ?, ?, ?, ?, ?, 'VENTA', ?, ?, ?, ?, ?
          )`,
          [
            lote.id_producto,
            item.id_lote,
            item.cantidad,
            saldoAnterior,
            saldoNuevo,
            headerResult.insertId,
            payload.receta_folio ?? null,
            userId ?? null,
            item.doble_verificacion_por ?? null,
            'Salida de controlado'
          ]
        );
      }
    }

    await recordProcessTrace(connection, {
      proceso: 'VENTA',
      subproceso: 'CREAR_VENTA',
      id_sede: payload.id_sede,
      id_usuario: userId ?? null,
      referencia_tipo: 'VENTA',
      referencia_id: headerResult.insertId,
      descripcion: `Venta ${payload.folio_venta} registrada (${payload.items.length} ítem${payload.items.length > 1 ? 's' : ''})`,
      payload_json: {
        folio_venta: payload.folio_venta,
        tipo: payload.tipo ?? 'mostrador',
        items: payload.items.length,
        total: totals.total,
        requiere_factura: payload.requiere_factura ?? false
      }
    });

    return {
      id_venta: headerResult.insertId,
      ...totals,
      requiere_factura: payload.requiere_factura ?? false
    };
  });
}
