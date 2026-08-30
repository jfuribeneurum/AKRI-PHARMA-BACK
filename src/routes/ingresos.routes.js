import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { authRequired } from '../middleware/auth.js';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { recordProcessTrace } from '../services/traceability.service.js';

const router = Router();
router.use(authRequired);

const itemSchema = z.object({
  codigo:          z.string().optional().nullable(),
  nombre:          z.string().optional().nullable(),
  laboratorio:     z.string().optional().nullable(),
  cantidad:        z.number().optional().default(0),
  valor_unitario:  z.number().optional().default(0),
  descuento_pct:   z.number().optional().default(0),
  descuento_valor: z.number().optional().default(0),
  iva:             z.number().optional().default(0),
  lote:            z.string().optional().nullable(),
  fecha_vencimiento: z.string().optional().nullable(),
  registro_invima: z.string().optional().nullable(),
  cum:             z.string().optional().nullable(),
  consecutivo_cum: z.string().optional().nullable(),
  presentacion:    z.string().optional().nullable(),
  temperatura:     z.string().optional().nullable(),
  cumple:          z.boolean().nullable().optional(),
});

const ingresoSchema = z.object({
  referencia:           z.string().min(1, 'Referencia requerida'),
  cantidad:             z.number().min(1, 'Cantidad debe ser mayor a 0'),
  lote:                 z.string().optional().nullable(),
  fecha_vencimiento:    z.string().optional().nullable(),
  estado:               z.enum(['recibido', 'cancelado']).default('recibido'),
  // Factura
  prefijo_factura:      z.string().optional().nullable(),
  numero_factura:       z.string().optional().nullable(),
  fecha_factura:        z.string().optional().nullable(),
  cufe:                 z.string().optional().nullable(),
  fecha_recepcion:      z.string().optional().nullable(),
  observaciones:        z.string().optional().nullable(),
  // Orden / sede
  numero_orden_compra:  z.string().optional().nullable(),
  sede:                 z.string().optional().nullable(),
  bodega:               z.string().optional().nullable(),
  id_almacen:           z.number().int().positive().optional().nullable(),
  // Proveedor
  proveedor_nombre:     z.string().optional().nullable(),
  proveedor_nit:        z.string().optional().nullable(),
  proveedor_contacto:   z.string().optional().nullable(),
  proveedor_telefono:   z.string().optional().nullable(),
  proveedor_direccion:  z.string().optional().nullable(),
  // Totales
  total_bruto:          z.number().optional().nullable(),
  total_descuento:      z.number().optional().nullable(),
  subtotal_neto:        z.number().optional().nullable(),
  total_iva:            z.number().optional().nullable(),
  total_ingreso:        z.number().optional().nullable(),
  // Items
  items:                z.array(itemSchema).optional().default([]),
  // Flag explícito para devoluciones (evita depender del prefijo de la referencia)
  es_devolucion:        z.boolean().optional().default(false),
  ingreso_original_ref: z.string().optional().nullable(),
});

// ──────────────────────────────────────────────
// Helper: construye el texto blob para actualizarInventario
// ──────────────────────────────────────────────
function buildProductoTexto(body) {
  const {
    items = [], numero_orden_compra, sede, bodega,
    proveedor_nombre, proveedor_nit, prefijo_factura, numero_factura
  } = body;

  const facturaStr = [prefijo_factura, numero_factura].filter(Boolean).join('');

  const metaLines = [
    numero_orden_compra ? `Orden: ${numero_orden_compra}` : '',
    sede                ? `Sede: ${sede}`                 : '',
    bodega              ? `Bodega: ${bodega}`             : '',
    proveedor_nombre    ? `Proveedor: ${proveedor_nombre}`: '',
    proveedor_nit       ? `NIT: ${proveedor_nit}`         : '',
    facturaStr          ? `Factura: ${facturaStr}`        : '',
  ].filter(Boolean).join('\n');

  const itemLines = items.map((item, idx) => {
    const base = [
      `Item ${idx + 1}:`,
      `codigo=${item.codigo || ''}`,
      `nombre=${item.nombre || ''}`,
      `laboratorio=${item.laboratorio || ''}`,
      `cantidad=${item.cantidad || 0}`,
      `valor_unitario=${item.valor_unitario || 0}`,
      `lote=${item.lote || ''}`,
      `vencimiento=${item.fecha_vencimiento || ''}`,
    ].join(' | ');

    const med = [
      item.registro_invima  ? `invima=${item.registro_invima}`        : '',
      item.cum              ? `cum=${item.cum}`                       : '',
      item.consecutivo_cum  ? `consec_cum=${item.consecutivo_cum}`    : '',
      item.presentacion     ? `presentacion=${item.presentacion}`     : '',
      item.iva              ? `iva=${item.iva}%`                      : '',
      item.temperatura      ? `temp=${item.temperatura}`              : '',
    ].filter(Boolean).join(' | ');

    return med ? `${base}\n   [MX: ${med}]` : base;
  }).join('\n');

  const primerNombre = items[0]?.nombre || 'Ingreso';
  return [primerNombre, metaLines, itemLines].filter(Boolean).join('\n');
}

// ──────────────────────────────────────────────
// Helpers de parseo (para actualizarInventario)
// ──────────────────────────────────────────────
function parsearItemsIngreso(texto) {
  const items = [];
  let i = 1;
  while (true) {
    const prefix = `Item ${i}:`;
    const lineIdx = texto.indexOf(prefix);
    if (lineIdx === -1) break;
    const lineEnd = texto.indexOf('\n', lineIdx);
    const linea = lineEnd === -1
      ? texto.slice(lineIdx + prefix.length)
      : texto.slice(lineIdx + prefix.length, lineEnd);
    const item = {};
    linea.split('|').forEach(part => {
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) {
        item[part.slice(0, eqIdx).trim()] = part.slice(eqIdx + 1).trim();
      }
    });
    items.push(item);
    i++;
  }
  return items;
}

function parsearMetaIngreso(texto) {
  const meta = {};
  texto.split('\n').forEach(linea => {
    if (linea.startsWith('Item ')) return;
    const colonIdx = linea.indexOf(':');
    if (colonIdx > 0) {
      meta[linea.slice(0, colonIdx).trim()] = linea.slice(colonIdx + 1).trim();
    }
  });
  return meta;
}

// ──────────────────────────────────────────────
// Actualización de inventario
// ──────────────────────────────────────────────
async function actualizarInventario(connection, productoTexto, referencia, ingresoId, esDevolucion, userId = null, idAlmacenActivo = null) {
  const items = parsearItemsIngreso(productoTexto);
  if (!items.length) return;

  let almacen = null;

  if (idAlmacenActivo) {
    [[almacen]] = await connection.query(
      `SELECT id_almacen FROM almacenes WHERE id_almacen = ? AND activo = 1 LIMIT 1`,
      [idAlmacenActivo]
    );
  }

  if (!almacen) {
    const meta = parsearMetaIngreso(productoTexto);
    const bodegaNombre = meta['Bodega'] || meta['Sede'] || '';

    if (bodegaNombre) {
      const [rows] = await connection.query(
        `SELECT id_almacen FROM almacenes WHERE activo = 1 AND nombre LIKE ? LIMIT 1`,
        [`%${bodegaNombre}%`]
      );
      almacen = rows[0] ?? null;
    }
  }

  if (!almacen) {
    [[almacen]] = await connection.query(
      `SELECT id_almacen FROM almacenes WHERE activo = 1 ORDER BY es_principal DESC LIMIT 1`
    );
  }
  if (!almacen) return;

  const [[ubicacion]] = await connection.query(
    `SELECT id_ubicacion FROM ubicaciones_almacen WHERE id_almacen = ? AND activo = 1 LIMIT 1`,
    [almacen.id_almacen]
  );
  if (!ubicacion) return;

  for (const item of items) {
    const cantidadRaw = esDevolucion
      ? (item.cantidad_devuelta || item.cantidad)
      : item.cantidad;
    const cantidad = parseFloat(cantidadRaw) || 0;
    if (!cantidad) continue;

    const nombreProducto = (item.nombre || '').trim();
    if (!nombreProducto) continue;
    const codigoItem = (item.codigo || '').trim();

    let [[producto]] = codigoItem
      ? await connection.query(
          `SELECT id_producto FROM productos WHERE codigo_control = ? LIMIT 1`,
          [codigoItem]
        )
      : [[null]];

    if (!producto && codigoItem) {
      [[producto]] = await connection.query(
        `SELECT id_producto FROM productos WHERE sku = ? LIMIT 1`,
        [codigoItem]
      );
    }

    if (!producto) {
      [[producto]] = await connection.query(
        `SELECT id_producto FROM productos WHERE nombre_comercial = ? LIMIT 1`,
        [nombreProducto]
      );
    }

    if (!producto) {
      const sku = codigoItem ||
        `AUTO${Date.now()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      const [res] = await connection.query(
        `INSERT INTO productos (sku, nombre_comercial, principio_activo) VALUES (?, ?, ?)`,
        [sku, nombreProducto, nombreProducto]
      );
      producto = { id_producto: res.insertId };
    }

    const numeroLote    = (item.lote || '').trim() || `LOTE-ING-${ingresoId}`;
    const fechaVen      = (item.vencimiento || '').trim() || '2099-12-31';
    const costoUnitario = parseFloat(item.valor_unitario) || 0;

    let [[lote]] = await connection.query(
      `SELECT id_lote FROM lotes WHERE id_producto = ? AND numero_lote = ? LIMIT 1`,
      [producto.id_producto, numeroLote]
    );

    if (!lote) {
      const [res] = await connection.query(
        `INSERT INTO lotes
           (id_producto, numero_lote, fecha_vencimiento, costo_unitario, precio_venta, estado)
         VALUES (?, ?, ?, ?, ?, 'disponible')`,
        [producto.id_producto, numeroLote, fechaVen, costoUnitario, costoUnitario]
      );
      lote = { id_lote: res.insertId };
    }

    const [[existencia]] = await connection.query(
      `SELECT id_existencia, cantidad_disponible
       FROM existencias
       WHERE id_lote = ? AND id_ubicacion = ? LIMIT 1`,
      [lote.id_lote, ubicacion.id_ubicacion]
    );

    if (esDevolucion) {
      if (existencia) {
        await connection.query(
          `UPDATE existencias
           SET cantidad_disponible = GREATEST(0, cantidad_disponible - ?)
           WHERE id_existencia = ?`,
          [cantidad, existencia.id_existencia]
        );
      }
      await connection.query(
        `INSERT INTO movimientos_inventario
           (tipo, id_producto, id_lote, id_almacen_origen, id_ubicacion_origen,
            cantidad, costo_unitario, motivo, referencia_tipo, referencia_id, id_usuario)
         VALUES ('devolucion_compra', ?, ?, ?, ?, ?, ?, ?, 'ingreso_pharma', ?, ?)`,
        [producto.id_producto, lote.id_lote,
         almacen.id_almacen, ubicacion.id_ubicacion,
         cantidad, costoUnitario,
         `Devolución: ${referencia}`, ingresoId, userId]
      );
    } else {
      if (existencia) {
        await connection.query(
          `UPDATE existencias
           SET cantidad_disponible = cantidad_disponible + ?
           WHERE id_existencia = ?`,
          [cantidad, existencia.id_existencia]
        );
      } else {
        await connection.query(
          `INSERT INTO existencias (id_lote, id_almacen, id_ubicacion, cantidad_disponible)
           VALUES (?, ?, ?, ?)`,
          [lote.id_lote, almacen.id_almacen, ubicacion.id_ubicacion, cantidad]
        );
      }
      await connection.query(
        `INSERT INTO movimientos_inventario
           (tipo, id_producto, id_lote, id_almacen_destino, id_ubicacion_destino,
            cantidad, costo_unitario, motivo, referencia_tipo, referencia_id, id_usuario)
         VALUES ('entrada_compra', ?, ?, ?, ?, ?, ?, ?, 'ingreso_pharma', ?, ?)`,
        [producto.id_producto, lote.id_lote,
         almacen.id_almacen, ubicacion.id_ubicacion,
         cantidad, costoUnitario,
         `Ingreso Pharma: ${referencia}`, ingresoId, userId]
      );
    }
  }
}

// ──────────────────────────────────────────────
// GET /ingresos
// ──────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [ingresos] = await connection.query(`
      SELECT
        i.id_ingreso,
        i.referencia,
        i.producto,
        i.cantidad,
        i.lote,
        i.fecha_vencimiento,
        i.estado,
        i.fecha_ingreso,
        i.created_at,
        i.updated_at,
        i.creado_por,
        i.prefijo_factura,
        i.numero_factura,
        i.fecha_factura,
        i.cufe,
        i.fecha_recepcion,
        i.observaciones,
        i.numero_orden_compra,
        i.sede,
        i.bodega,
        i.proveedor_nombre,
        i.proveedor_nit,
        i.proveedor_contacto,
        i.proveedor_telefono,
        i.proveedor_direccion,
        i.total_bruto,
        i.total_descuento,
        i.subtotal_neto,
        i.total_iva,
        i.total_ingreso,
        u.nombre_completo AS creado_por_nombre
      FROM ingresos i
      LEFT JOIN usuarios u ON u.id_usuario = i.creado_por
      ORDER BY i.created_at DESC
    `);

    res.json({ success: true, data: ingresos });
  } finally {
    connection.release();
  }
}));

// ──────────────────────────────────────────────
// POST /ingresos
// ──────────────────────────────────────────────
router.post('/', validate(ingresoSchema), asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const {
      referencia, cantidad, lote, fecha_vencimiento, estado,
      prefijo_factura, numero_factura, fecha_factura, cufe, fecha_recepcion, observaciones,
      numero_orden_compra, sede, bodega, id_almacen,
      proveedor_nombre, proveedor_nit, proveedor_contacto, proveedor_telefono, proveedor_direccion,
      total_bruto, total_descuento, subtotal_neto, total_iva, total_ingreso,
      items = [],
      es_devolucion = false,
    } = req.body;

    const productoTexto = buildProductoTexto(req.body);
    const idAlmacenActivo = id_almacen ?? req.user?.id_almacen ?? null;

    const [result] = await connection.query(`
      INSERT INTO ingresos (
        referencia, producto, cantidad, lote, fecha_vencimiento, estado,
        fecha_ingreso, creado_por,
        prefijo_factura, numero_factura, fecha_factura, cufe, fecha_recepcion, observaciones,
        numero_orden_compra, sede, bodega, id_almacen,
        proveedor_nombre, proveedor_nit, proveedor_contacto, proveedor_telefono, proveedor_direccion,
        total_bruto, total_descuento, subtotal_neto, total_iva, total_ingreso
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        NOW(), ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `, [
      referencia, productoTexto, cantidad, lote || null, fecha_vencimiento || null, estado,
      req.user?.sub ?? null,
      prefijo_factura || null, numero_factura || null, fecha_factura || null, cufe || null,
      fecha_recepcion || null, observaciones || null,
      numero_orden_compra || null, sede || null, bodega || null, idAlmacenActivo,
      proveedor_nombre || null, proveedor_nit || null,
      proveedor_contacto || null, proveedor_telefono || null, proveedor_direccion || null,
      total_bruto ?? null, total_descuento ?? null, subtotal_neto ?? null,
      total_iva ?? null, total_ingreso ?? null,
    ]);

    const ingresoId = result.insertId;

    // Insertar items en tabla estructurada
    for (const item of items) {
      await connection.query(`
        INSERT INTO ingresos_items (
          id_ingreso, codigo, nombre, laboratorio,
          cantidad, valor_unitario, descuento_pct, descuento_valor, iva,
          lote, fecha_vencimiento,
          registro_invima, cum, consecutivo_cum, presentacion, temperatura, cumple
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        ingresoId,
        item.codigo || null, item.nombre || null, item.laboratorio || null,
        item.cantidad ?? 0, item.valor_unitario ?? 0,
        item.descuento_pct ?? 0, item.descuento_valor ?? 0, item.iva ?? 0,
        item.lote || null, item.fecha_vencimiento || null,
        item.registro_invima || null, item.cum || null, item.consecutivo_cum || null,
        item.presentacion || null, item.temperatura || null,
        item.cumple != null ? (item.cumple ? 1 : 0) : null,
      ]);
    }

    const esDevolucion = es_devolucion || referencia.startsWith('DEV-');
    const debeActualizar =
      estado === 'recibido' ||
      (estado === 'cancelado' && esDevolucion);

    if (debeActualizar) {
      try {
        await actualizarInventario(connection, productoTexto, referencia, ingresoId, esDevolucion, req.user?.sub ?? null, idAlmacenActivo);
      } catch (invErr) {
        console.error('[ingresos] Error actualizando inventario:', invErr.message);
      }
    }

    await recordProcessTrace(connection, {
      proceso: 'COMPRAS',
      subproceso: esDevolucion ? 'INGRESO_DEVOLUCION' : 'INGRESO_RECEPCION',
      id_usuario: req.user?.sub ?? null,
      referencia_tipo: 'INGRESO',
      referencia_id: ingresoId,
      descripcion: `Ingreso ${referencia} registrado (${items.length} ítem${items.length === 1 ? '' : 's'})`,
      payload_json: { numero_orden_compra: numero_orden_compra ?? null, estado, cantidad, total_ingreso: total_ingreso ?? null }
    });

    res.status(201).json({ success: true, message: 'Ingreso creado exitosamente' });
  } finally {
    connection.release();
  }
}));

// ──────────────────────────────────────────────
// GET /ingresos/:id
// ──────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [[ingreso]] = await connection.query(`
      SELECT i.*, u.nombre_completo AS creado_por_nombre
        FROM ingresos i
        LEFT JOIN usuarios u ON u.id_usuario = i.creado_por
       WHERE i.id_ingreso = ?
    `, [req.params.id]);

    if (!ingreso) {
      return res.status(404).json({ success: false, message: 'Ingreso no encontrado' });
    }

    const [items] = await connection.query(`
      SELECT * FROM ingresos_items WHERE id_ingreso = ? ORDER BY id_item
    `, [req.params.id]);

    res.json({ success: true, data: { ...ingreso, items } });
  } finally {
    connection.release();
  }
}));

// ──────────────────────────────────────────────
// PUT /ingresos/:id
// ──────────────────────────────────────────────
router.put('/:id', asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { referencia, producto, cantidad, lote, fecha_vencimiento, estado } = req.body;

    await connection.query(`
      UPDATE ingresos
      SET referencia = ?, producto = ?, cantidad = ?, lote = ?,
          fecha_vencimiento = ?, estado = ?, updated_at = NOW()
      WHERE id_ingreso = ?
    `, [referencia, producto, cantidad, lote, fecha_vencimiento, estado, req.params.id]);

    await recordProcessTrace(connection, {
      proceso: 'COMPRAS',
      subproceso: 'INGRESO_EDICION',
      id_usuario: req.user?.sub ?? null,
      referencia_tipo: 'INGRESO',
      referencia_id: Number(req.params.id),
      descripcion: `Ingreso ${referencia} editado`
    });

    res.json({ success: true, message: 'Ingreso actualizado exitosamente' });
  } finally {
    connection.release();
  }
}));

// ──────────────────────────────────────────────
// DELETE /ingresos/:id
// ──────────────────────────────────────────────
router.delete('/:id', asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [[ingreso]] = await connection.query(`SELECT referencia FROM ingresos WHERE id_ingreso = ?`, [req.params.id]);

    await connection.query(`DELETE FROM ingresos WHERE id_ingreso = ?`, [req.params.id]);

    // Nota: esto elimina el encabezado del ingreso pero NO revierte el
    // inventario que ya se sumó a existencias/movimientos_inventario al
    // crearlo — queda fuera del alcance de este cambio (solo trazabilidad).
    await recordProcessTrace(connection, {
      proceso: 'COMPRAS',
      subproceso: 'INGRESO_ELIMINACION',
      id_usuario: req.user?.sub ?? null,
      referencia_tipo: 'INGRESO',
      referencia_id: Number(req.params.id),
      descripcion: `Ingreso ${ingreso?.referencia ?? req.params.id} eliminado`
    });

    res.json({ success: true, message: 'Ingreso eliminado exitosamente' });
  } finally {
    connection.release();
  }
}));

export { router as ingresosRouter };
