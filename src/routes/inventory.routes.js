import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  listStock,
  createMovement,
  getInventoryLookups,
  listRecentBarcodeScans,
  resolveBarcode,
  resolveBarcodeForLegacyLookup,
  registerBarcodeIngress,
  registerBarcodeEgress,
  getInventorySummary,
  getInventoryBySite,
  getStockByProductId
} from '../services/inventory.service.js';

const movementSchema = z.object({
  tipo: z.enum([
    'entrada_compra', 'salida_venta', 'ajuste', 'traslado', 'devolucion_compra',
    'devolucion_venta', 'merma', 'cuarentena', 'liberacion', 'destruccion',
    'inventario_faltante_fisico', 'disposicion_final', 'movimiento_interno',
    'inventario_sobrante_fisico', 'bonificacion'
  ]),
  id_lote: z.number().int(),
  id_almacen_origen: z.number().int().optional().nullable(),
  id_ubicacion_origen: z.number().int().optional().nullable(),
  id_almacen_destino: z.number().int().optional().nullable(),
  id_ubicacion_destino: z.number().int().optional().nullable(),
  cantidad: z.number().positive(),
  costo_unitario: z.number().optional().nullable(),
  motivo: z.string().optional().nullable(),
  referencia_tipo: z.string().optional().nullable(),
  referencia_id: z.number().int().optional().nullable()
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
    const data = await getInventoryLookups(req.user.id_sede ?? null);
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
    const data = await listStock(String(req.query.search ?? ''), req.user.id_almacen ?? null);
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
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'ID inválido' });
    }
    const data = await getStockByProductId(id);
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
