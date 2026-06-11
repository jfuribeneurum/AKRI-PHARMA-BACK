import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { authRequired } from '../middleware/auth.js';
import { z } from 'zod';
import { pool } from '../config/db.js';

const router = Router();
router.use(authRequired);

const ingresoSchema = z.object({
  referencia: z.string().min(1, 'Referencia requerida'),
  producto: z.string().min(1, 'Producto requerido'),
  cantidad: z.number().min(1, 'Cantidad debe ser mayor a 0'),
  lote: z.string().optional(),
  fecha_vencimiento: z.string().optional(),
  estado: z.enum(['pendiente', 'recibido', 'almacenado', 'cancelado']).default('pendiente')
});

// ──────────────────────────────────────────────
// Helpers de parseo (misma lógica que el frontend)
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
async function actualizarInventario(connection, productoTexto, referencia, ingresoId, esDevolucion, userId = null) {
  const items = parsearItemsIngreso(productoTexto);
  if (!items.length) return;

  const meta = parsearMetaIngreso(productoTexto);
  const bodegaNombre = meta['Bodega'] || meta['Sede'] || '';

  // Buscar almacén: primero por nombre de bodega, luego el principal, luego cualquiera activo
  let [[almacen]] = bodegaNombre
    ? await connection.query(
        `SELECT id_almacen FROM almacenes WHERE activo = 1 AND nombre LIKE ? LIMIT 1`,
        [`%${bodegaNombre}%`]
      )
    : [[null]];

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
    // En devoluciones se usa la clave cantidad_devuelta; en entradas, cantidad
    const cantidadRaw = esDevolucion
      ? (item.cantidad_devuelta || item.cantidad)
      : item.cantidad;
    const cantidad = parseFloat(cantidadRaw) || 0;
    if (!cantidad) continue;

    const nombreProducto = (item.nombre || '').trim();
    if (!nombreProducto) continue;
    const codigoItem = (item.codigo || '').trim();

    // Buscar producto por codigo_control (ej: MX01-4.1) → identifica lab exacto
    let [[producto]] = codigoItem
      ? await connection.query(
          `SELECT id_producto FROM productos WHERE codigo_control = ? LIMIT 1`,
          [codigoItem]
        )
      : [[null]];

    // Fallback: buscar por sku exacto si codigo_control no coincide
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

    // Crear producto si no existe
    if (!producto) {
      const sku = codigoItem ||
        `AUTO${Date.now()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      const [res] = await connection.query(
        `INSERT INTO productos (sku, nombre_comercial, principio_activo) VALUES (?, ?, ?)`,
        [sku, nombreProducto, nombreProducto]
      );
      producto = { id_producto: res.insertId };
    }

    // Buscar o crear lote
    const numeroLote = (item.lote || '').trim() || `LOTE-ING-${ingresoId}`;
    const fechaVen   = (item.vencimiento || '').trim() || '2099-12-31';
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

    // Buscar existencia actual
    const [[existencia]] = await connection.query(
      `SELECT id_existencia, cantidad_disponible
       FROM existencias
       WHERE id_lote = ? AND id_ubicacion = ? LIMIT 1`,
      [lote.id_lote, ubicacion.id_ubicacion]
    );

    if (esDevolucion) {
      // Devolución → restar del inventario (sin bajar de 0)
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
         VALUES ('devolucion_compra', ?, ?, ?, ?, ?, ?, ?, 'ingreso_sebas', ?, ?)`,
        [producto.id_producto, lote.id_lote,
         almacen.id_almacen, ubicacion.id_ubicacion,
         cantidad, costoUnitario,
         `Devolución: ${referencia}`, ingresoId, userId]
      );
    } else {
      // Entrada → sumar al inventario
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
         VALUES ('entrada_compra', ?, ?, ?, ?, ?, ?, ?, 'ingreso_sebas', ?, ?)`,
        [producto.id_producto, lote.id_lote,
         almacen.id_almacen, ubicacion.id_ubicacion,
         cantidad, costoUnitario,
         `Ingreso Sebas: ${referencia}`, ingresoId, userId]
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
        u.nombre_completo AS creado_por_nombre
      FROM ingresos i
      LEFT JOIN usuarios u ON u.id_usuario = i.creado_por
      ORDER BY i.created_at DESC
    `);

    res.json({
      success: true,
      data: ingresos
    });
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
    const { referencia, producto, cantidad, lote, fecha_vencimiento, estado } = req.body;

    const [result] = await connection.query(`
      INSERT INTO ingresos
        (referencia, producto, cantidad, lote, fecha_vencimiento, estado, fecha_ingreso, creado_por)
      VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)
    `, [referencia, producto, cantidad, lote || null, fecha_vencimiento || null, estado, req.user?.sub ?? null]);

    const ingresoId = result.insertId;
    const esDevolucion = referencia.startsWith('DEV-');

    // Actualizar inventario cuando corresponda
    const debeActualizar =
      estado === 'recibido' ||
      estado === 'almacenado' ||
      (estado === 'cancelado' && esDevolucion);

    if (debeActualizar) {
      try {
        await actualizarInventario(connection, producto, referencia, ingresoId, esDevolucion, req.user?.sub ?? null);
      } catch (invErr) {
        console.error('[ingresos] Error actualizando inventario:', invErr.message);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Ingreso creado exitosamente'
    });
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
      SELECT * FROM ingresos WHERE id_ingreso = ?
    `, [req.params.id]);

    if (!ingreso) {
      return res.status(404).json({
        success: false,
        message: 'Ingreso no encontrado'
      });
    }

    res.json({
      success: true,
      data: ingreso
    });
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

    res.json({
      success: true,
      message: 'Ingreso actualizado exitosamente'
    });
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
    await connection.query(`
      DELETE FROM ingresos WHERE id_ingreso = ?
    `, [req.params.id]);

    res.json({
      success: true,
      message: 'Ingreso eliminado exitosamente'
    });
  } finally {
    connection.release();
  }
}));

export { router as ingresosRouter };
