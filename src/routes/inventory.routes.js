import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  listStock,
  createMovement,
  getInventoryLookups,
  listMovementHistory,
  anularMovimiento,
  listRecentBarcodeScans,
  resolveBarcode,
  resolveBarcodeForLegacyLookup,
  registerBarcodeIngress,
  registerBarcodeEgress,
  getInventorySummary,
  getInventoryBySite,
  getStockByProductId
} from '../services/inventory.service.js';
import { listWarehousesForOwnCity, listWarehousesForPO, getSedeGroupIdsForUser } from '../services/purchase.service.js';

const movementSchema = z.object({
  // Antes era un z.enum fijo. Un tipo válido en el módulo de Parámetros
  // (tipo_movimiento_entrada/salida) pero ausente de esta lista fallaba
  // SIEMPRE con "Validación fallida" (pasó con 'OTRO' y 'CONSUMO'), sin
  // importar producto/cantidad/bodega, porque nadie sabía que había que
  // sincronizar dos listas cada vez que se agregaba un tipo nuevo. Ahora
  // solo se exige que no venga vacío — el valor real se valida
  // dinámicamente en createMovement contra los tipos internos del sistema
  // más los activos en parametros_sistema, así un tipo agregado en
  // Parámetros funciona de inmediato sin tocar este archivo.
  tipo: z.string().min(1, 'El tipo de movimiento es obligatorio'),
  id_lote: z.number().int().optional().nullable(),
  // Alternativa a id_lote cuando el lote todavía no existe (producto nunca
  // antes registrado en esta bodega, o lote nuevo de uno ya conocido) — ver
  // createMovement, que lo busca o lo crea antes de mover inventario.
  id_producto: z.number().int().optional().nullable(),
  numero_lote: z.string().optional().nullable(),
  fecha_vencimiento: z.string().optional().nullable(),
  id_almacen_origen: z.number().int().optional().nullable(),
  id_ubicacion_origen: z.number().int().optional().nullable(),
  id_almacen_destino: z.number().int().optional().nullable(),
  id_ubicacion_destino: z.number().int().optional().nullable(),
  cantidad: z.number().positive(),
  costo_unitario: z.number().optional().nullable(),
  motivo: z.string().optional().nullable(),
  referencia_tipo: z.string().optional().nullable(),
  referencia_id: z.number().int().optional().nullable()
}).refine((data) => data.id_lote != null || data.id_producto != null, {
  message: 'Debes indicar id_lote o id_producto',
  path: ['id_lote']
});

const barcodeResolveSchema = z.object({
  barcode: z.string().min(4),
  mode: z.enum(['consulta', 'ingreso', 'egreso']).default('consulta'),
  source: z.enum(['lector', 'camara', 'manual']).default('lector')
});

const barcodeIngressSchema = z.object({
  barcode: z.string().min(4),
  source: z.enum(['lector', 'camara', 'manual']).default('lector'),
  quantity: z.number().positive(),
  id_ubicacion_destino: z.number().int(),
  numero_lote: z.string().min(2),
  fecha_vencimiento: z.string().min(8),
  fecha_fabricacion: z.string().optional().nullable(),
  id_proveedor: z.number().int().optional().nullable(),
  registro_sanitario: z.string().optional().nullable(),
  costo_unitario: z.number().optional().nullable(),
  precio_venta: z.number().optional().nullable(),
  motivo: z.string().optional().nullable(),
  referencia_tipo: z.string().optional().nullable(),
  referencia_id: z.number().int().optional().nullable()
});

const barcodeEgressSchema = z.object({
  barcode: z.string().min(4),
  source: z.enum(['lector', 'camara', 'manual']).default('lector'),
  quantity: z.number().positive(),
  id_lote: z.number().int().optional().nullable(),
  id_ubicacion_origen: z.number().int().optional().nullable(),
  tipo_egreso: z.enum(['salida_venta', 'merma', 'devolucion_compra', 'destruccion']).default('salida_venta'),
  motivo: z.string().optional().nullable(),
  referencia_tipo: z.string().optional().nullable(),
  referencia_id: z.number().int().optional().nullable()
});

export const inventoryRouter = Router();

inventoryRouter.get(
  '/lookups',
  authRequired,
  asyncHandler(async (req, res) => {
    // scope=propia: ubicaciones de las bodegas principales de TODA la ciudad
    // de la sede activa (mismo agrupamiento que /purchases/warehouses?scope=propia,
    // usado por "Bodega destino" en Movimiento de Entrada), no solo la sede
    // literal — ver getInventoryLookups.
    // scope=gestion: mismo problema pero para pantallas de gestión general
    // (Traslados: "Bodega receptora") donde /purchases/warehouses (sin
    // scope=propia) usa getSedeGroupIdsForUser — que para ADMINISTRADOR NO
    // se limita a la ciudad activa, sino a las 4 sedes. Sin este scope, un
    // admin podía elegir como receptora una bodega de otra ciudad cuya
    // ubicación nunca se había resuelto, y "enviar" fallaba con "la bodega
    // receptora no tiene ubicaciones configuradas" aunque sí las tenga.
    let almacenIds = null;
    if (req.query.scope === 'propia') {
      almacenIds = (await listWarehousesForOwnCity(req.user.id_sede ?? null)).map((a) => a.id_almacen);
    } else if (req.query.scope === 'gestion') {
      const groupIds = await getSedeGroupIdsForUser(req.user);
      almacenIds = (await listWarehousesForPO(groupIds)).map((a) => a.id_almacen);
    }
    const data = await getInventoryLookups(req.user.id_sede ?? null, almacenIds);
    res.json({ success: true, data });
  })
);



inventoryRouter.get(
  '/summary',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await getInventorySummary(
      String(req.query.scope ?? 'general'),
      req.query.id_sede ? Number(req.query.id_sede) : null,
      String(req.query.search ?? '')
    );
    res.json({ success: true, data });
  })
);

inventoryRouter.get(
  '/summary/by-site',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await getInventoryBySite(String(req.query.search ?? ''));
    res.json({ success: true, data });
  })
);

inventoryRouter.get(
  '/stock',
  authRequired,
  asyncHandler(async (req, res) => {
    const tipoProducto = req.query.tipo_producto ? String(req.query.tipo_producto) : null;
    const data = await listStock(String(req.query.search ?? ''), req.user.id_almacen ?? null, tipoProducto);
    res.json({ success: true, data });
  })
);

inventoryRouter.get(
  '/scans/recent',
  authRequired,
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit ?? 12);
    const data = await listRecentBarcodeScans(Number.isFinite(limit) ? limit : 12);
    res.json({ success: true, data });
  })
);


inventoryRouter.get(
  '/barcode/lookup/:barcode',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await resolveBarcodeForLegacyLookup(String(req.params.barcode), req.user.sub, 'manual');
    res.json({ success: true, data });
  })
);

inventoryRouter.get(
  '/barcode/:barcode/resolve',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await resolveBarcodeForLegacyLookup(String(req.params.barcode), req.user.sub, 'manual');
    res.json({ success: true, data });
  })
);

inventoryRouter.post(
  '/barcode/resolve',
  authRequired,
  validate(barcodeResolveSchema),
  asyncHandler(async (req, res) => {
    const data = await resolveBarcode(req.body, req.user.sub);
    res.json({ success: true, data });
  })
);

inventoryRouter.post(
  '/barcode/ingress',
  authRequired,
  validate(barcodeIngressSchema),
  asyncHandler(async (req, res) => {
    const data = await registerBarcodeIngress(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

inventoryRouter.post(
  '/barcode/egress',
  authRequired,
  validate(barcodeEgressSchema),
  asyncHandler(async (req, res) => {
    const data = await registerBarcodeEgress(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

inventoryRouter.get(
  '/stock/product/:id',
  authRequired,
  asyncHandler(async (req, res) => {
    // :id acepta uno o varios ids separados por coma (productos duplicados
    // del mismo genérico) para poder sumar el stock real de todos.
    const ids = req.params.id.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 1);
    if (!ids.length) {
      return res.status(400).json({ success: false, message: 'ID inválido' });
    }
    const data = await getStockByProductId(ids, req.user?.id_sede ?? null);
    res.json({ success: true, data });
  })
);

inventoryRouter.post(
  '/movements',
  authRequired,
  validate(movementSchema),
  asyncHandler(async (req, res) => {
    const data = await createMovement(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

inventoryRouter.get(
  '/movements/history',
  authRequired,
  asyncHandler(async (req, res) => {
    const direction = req.query.direction === 'salida' ? 'salida' : 'entrada';
    const almacenIds = (await listWarehousesForOwnCity(req.user.id_sede ?? null)).map((a) => a.id_almacen);
    const data = await listMovementHistory({ almacenIds, direction, limit: req.query.limit });
    res.json({ success: true, data });
  })
);

const anularMovimientoSchema = z.object({
  motivo: z.string().max(255).optional().nullable()
});

inventoryRouter.post(
  '/movements/:id/anular',
  authRequired,
  validate(anularMovimientoSchema),
  asyncHandler(async (req, res) => {
    const data = await anularMovimiento(Number(req.params.id), req.user.sub, req.body.motivo ?? null);
    res.json({ success: true, data });
  })
);
