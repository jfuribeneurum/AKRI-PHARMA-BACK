import { query } from '../config/db.js';

export async function getSummary() {
  const [productsMeta] = await query(
    `SELECT
        COUNT(*) AS total_products,
        SUM(CASE WHEN activo = TRUE THEN 1 ELSE 0 END) AS active_products,
        SUM(CASE WHEN codigo_barras IS NOT NULL AND codigo_barras <> '' THEN 1 ELSE 0 END) AS products_with_barcode,
        SUM(CASE WHEN requiere_cadena_frio = TRUE THEN 1 ELSE 0 END) AS cold_chain_products,
        SUM(CASE WHEN es_controlado = TRUE THEN 1 ELSE 0 END) AS controlled_products
     FROM productos`
  );

  const [productsWithImages] = await query(
    `SELECT COUNT(DISTINCT id_producto) AS total FROM productos_imagenes`
  );

  const [stockHealth] = await query(
    `SELECT
        SUM(CASE WHEN stock_actual <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
        SUM(CASE WHEN stock_minimo > 0 AND stock_actual > 0 AND stock_actual <= stock_minimo * 0.5 THEN 1 ELSE 0 END) AS critical_stock,
        SUM(CASE WHEN stock_minimo > 0 AND stock_actual > stock_minimo * 0.5 AND stock_actual <= stock_minimo THEN 1 ELSE 0 END) AS low_stock,
        SUM(CASE WHEN stock_actual > COALESCE(stock_minimo, 0) THEN 1 ELSE 0 END) AS healthy_stock,
        ROUND(COALESCE(SUM(stock_actual * costo_referencia), 0), 2) AS inventory_value
     FROM (
        SELECT p.id_producto, p.stock_minimo, p.costo_referencia,
               COALESCE(SUM(e.cantidad_disponible), 0) AS stock_actual
        FROM productos p
        LEFT JOIN lotes l ON l.id_producto = p.id_producto
        LEFT JOIN existencias e ON e.id_lote = l.id_lote
        WHERE p.activo = TRUE
        GROUP BY p.id_producto, p.stock_minimo, p.costo_referencia
     ) resumen`
  );

  const [expirationMeta] = await query(
    `SELECT
        SUM(CASE WHEN fecha_vencimiento < CURRENT_DATE() THEN 1 ELSE 0 END) AS expired_lots,
        SUM(CASE WHEN fecha_vencimiento BETWEEN CURRENT_DATE() AND DATE_ADD(CURRENT_DATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS expiring_30,
        SUM(CASE WHEN fecha_vencimiento BETWEEN CURRENT_DATE() AND DATE_ADD(CURRENT_DATE(), INTERVAL 90 DAY) THEN 1 ELSE 0 END) AS expiring_90
     FROM lotes
     WHERE estado IN ('disponible', 'cuarentena', 'bloqueado', 'vencido')`
  );

  const [coldAlerts] = await query(
    `SELECT COUNT(*) AS total
     FROM alertas_cadena_frio
     WHERE estado IN ('abierta', 'en_proceso')`
  );

  const [openPurchases] = await query(
    `SELECT COUNT(*) AS total
     FROM ordenes_compra
     WHERE estado IN ('aprobada', 'recibida_parcial')`
  );

  const [openInvoices] = await query(
    `SELECT COUNT(*) AS total
     FROM facturas
     WHERE estado IN ('emitida', 'enviada_siesa', 'rechazada')`
  );

  const lowStock = await query(
    `SELECT
        p.id_producto,
        p.sku,
        p.nombre_comercial,
        p.stock_minimo,
        ROUND(COALESCE(SUM(e.cantidad_disponible), 0), 3) AS stock_actual,
        CASE
          WHEN COALESCE(SUM(e.cantidad_disponible), 0) <= 0 THEN 'agotado'
          WHEN COALESCE(SUM(e.cantidad_disponible), 0) <= p.stock_minimo * 0.5 THEN 'critico'
          ELSE 'bajo'
        END AS severidad
     FROM productos p
     LEFT JOIN lotes l ON l.id_producto = p.id_producto
     LEFT JOIN existencias e ON e.id_lote = l.id_lote
     WHERE p.activo = TRUE
     GROUP BY p.id_producto, p.sku, p.nombre_comercial, p.stock_minimo
     HAVING stock_actual <= p.stock_minimo
     ORDER BY stock_actual ASC, p.nombre_comercial ASC
     LIMIT 10`
  );

  const expiringLots = await query(
    `SELECT
        p.sku,
        p.nombre_comercial,
        l.id_lote,
        l.numero_lote,
        l.fecha_vencimiento,
        DATEDIFF(l.fecha_vencimiento, CURRENT_DATE()) AS dias_para_vencer,
        ROUND(COALESCE(SUM(e.cantidad_disponible), 0), 3) AS cantidad_disponible
     FROM lotes l
     INNER JOIN productos p ON p.id_producto = l.id_producto
     LEFT JOIN existencias e ON e.id_lote = l.id_lote
     WHERE l.fecha_vencimiento BETWEEN CURRENT_DATE() AND DATE_ADD(CURRENT_DATE(), INTERVAL 90 DAY)
     GROUP BY p.sku, p.nombre_comercial, l.id_lote, l.numero_lote, l.fecha_vencimiento
     HAVING cantidad_disponible > 0
     ORDER BY l.fecha_vencimiento ASC, cantidad_disponible DESC
     LIMIT 10`
  );

  const categoryBreakdown = await query(
    `SELECT
        COALESCE(cp.nombre, 'Sin categoría') AS categoria,
        ROUND(COALESCE(SUM(e.cantidad_disponible), 0), 3) AS unidades,
        ROUND(COALESCE(SUM(e.cantidad_disponible * l.costo_unitario), 0), 2) AS valor
     FROM productos p
     LEFT JOIN categorias_producto cp ON cp.id_categoria = p.id_categoria
     LEFT JOIN lotes l ON l.id_producto = p.id_producto
     LEFT JOIN existencias e ON e.id_lote = l.id_lote
     WHERE p.activo = TRUE
     GROUP BY COALESCE(cp.nombre, 'Sin categoría')
     HAVING unidades > 0 OR valor > 0
     ORDER BY valor DESC, unidades DESC
     LIMIT 8`
  );

  const storageBreakdown = await query(
    `SELECT
        a.tipo AS tipo_almacen,
        COUNT(DISTINCT e.id_lote) AS lotes,
        ROUND(COALESCE(SUM(e.cantidad_disponible), 0), 3) AS unidades,
        ROUND(COALESCE(SUM(e.cantidad_disponible * l.costo_unitario), 0), 2) AS valor
     FROM almacenes a
     LEFT JOIN existencias e ON e.id_almacen = a.id_almacen
     LEFT JOIN lotes l ON l.id_lote = e.id_lote
     GROUP BY a.tipo
     ORDER BY valor DESC, unidades DESC`
  );

  const monthlyMovements = await query(
    `SELECT
        DATE_FORMAT(fecha_hora, '%Y-%m') AS periodo,
        ROUND(SUM(CASE WHEN tipo IN ('entrada_compra', 'devolucion_venta', 'liberacion') THEN cantidad ELSE 0 END), 3) AS ingresos,
        ROUND(SUM(CASE WHEN tipo IN ('salida_venta', 'devolucion_compra', 'merma', 'destruccion', 'cuarentena') THEN cantidad ELSE 0 END), 3) AS egresos
     FROM movimientos_inventario
     WHERE fecha_hora >= DATE_SUB(CURRENT_DATE(), INTERVAL 6 MONTH)
     GROUP BY DATE_FORMAT(fecha_hora, '%Y-%m')
     ORDER BY periodo ASC`
  );

  const recentScans = await query(
    `SELECT
        s.fecha_hora,
        s.modo,
        s.fuente,
        s.codigo_barras,
        s.resultado,
        s.cantidad,
        p.sku,
        p.nombre_comercial,
        l.numero_lote
     FROM escaneos_codigo_barras s
     LEFT JOIN productos p ON p.id_producto = s.id_producto
     LEFT JOIN lotes l ON l.id_lote = s.id_lote
     ORDER BY s.fecha_hora DESC
     LIMIT 8`
  );

  const coldChainStatus = await query(
    `SELECT
        eq.id_equipo,
        eq.nombre AS equipo,
        alm.nombre AS almacen,
        eq.temp_min,
        eq.temp_max,
        lc.fecha_hora AS ultima_lectura,
        lc.temperatura,
        lc.humedad,
        CASE
          WHEN lc.id_lectura IS NULL THEN 'sin_lectura'
          WHEN lc.temperatura BETWEEN eq.temp_min AND eq.temp_max THEN 'en_rango'
          ELSE 'fuera_rango'
        END AS estado
     FROM equipos_cadena_frio eq
     INNER JOIN almacenes alm ON alm.id_almacen = eq.id_almacen
     LEFT JOIN lecturas_cadena_frio lc ON lc.id_lectura = (
       SELECT lc2.id_lectura
       FROM lecturas_cadena_frio lc2
       WHERE lc2.id_equipo = eq.id_equipo
       ORDER BY lc2.fecha_hora DESC
       LIMIT 1
     )
     WHERE eq.activo = TRUE
     ORDER BY eq.nombre ASC`
  );

  return {
    generatedAt: new Date().toISOString(),
    counters: {
      products: Number(productsMeta?.active_products ?? 0),
      totalProducts: Number(productsMeta?.total_products ?? 0),
      productsWithBarcode: Number(productsMeta?.products_with_barcode ?? 0),
      productsWithImages: Number(productsWithImages?.total ?? 0),
      coldChainProducts: Number(productsMeta?.cold_chain_products ?? 0),
      controlledProducts: Number(productsMeta?.controlled_products ?? 0),
      lowStock: Number(stockHealth?.low_stock ?? 0),
      criticalStock: Number(stockHealth?.critical_stock ?? 0),
      outOfStock: Number(stockHealth?.out_of_stock ?? 0),
      healthyStock: Number(stockHealth?.healthy_stock ?? 0),
      inventoryValue: Number(stockHealth?.inventory_value ?? 0),
      expiredLots: Number(expirationMeta?.expired_lots ?? 0),
      lotsExpiring30Days: Number(expirationMeta?.expiring_30 ?? 0),
      lotsExpiring90Days: Number(expirationMeta?.expiring_90 ?? 0),
      coldChainOpenAlerts: Number(coldAlerts?.total ?? 0),
      purchasesPendingReceipt: Number(openPurchases?.total ?? 0),
      invoicesPendingSync: Number(openInvoices?.total ?? 0)
    },
    coverage: {
      barcodePct: Number(productsMeta?.active_products ?? 0) > 0
        ? Math.round((Number(productsMeta?.products_with_barcode ?? 0) / Number(productsMeta?.active_products ?? 0)) * 100)
        : 0,
      imagesPct: Number(productsMeta?.active_products ?? 0) > 0
        ? Math.round((Number(productsWithImages?.total ?? 0) / Number(productsMeta?.active_products ?? 0)) * 100)
        : 0
    },
    stockHealth,
    lowStock,
    expiringLots,
    categoryBreakdown,
    storageBreakdown,
    monthlyMovements,
    recentScans,
    coldChainStatus
  };
}
