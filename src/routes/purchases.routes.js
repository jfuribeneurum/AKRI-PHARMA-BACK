import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { listPurchases, createPurchaseOrder, receivePurchaseOrder } from '../services/purchase.service.js';

const purchaseItemSchema = z.object({
  id_producto: z.number().int(),
  cantidad: z.number().positive(),
  precio_unitario: z.number().nonnegative(),
  descuento: z.number().optional(),
  impuesto: z.number().optional(),
  fecha_requerida: z.string().optional().nullable()
});

const purchaseSchema = z.object({
  numero_oc: z.string().min(2),
  id_proveedor: z.number().int(),
  estado: z.enum(['borrador', 'aprobada']).optional(),
  observaciones: z.string().optional().nullable(),
  items: z.array(purchaseItemSchema).min(1)
});

const receptionItemSchema = z.object({
  id_producto: z.number().int(),
  numero_lote: z.string().min(1),
  fecha_vencimiento: z.string().min(10),
  cantidad_recibida: z.number().positive(),
  costo_unitario: z.number().nonnegative()
});

const receptionSchema = z.object({
  id_almacen: z.number().int(),
  numero_factura_proveedor: z.string().optional().nullable(),
  observaciones: z.string().optional().nullable(),
  items: z.array(receptionItemSchema).min(1)
});

export const purchasesRouter = Router();

purchasesRouter.get(
  '/',
  authRequired,
  asyncHandler(async (_req, res) => {
    const data = await listPurchases(req.user);
    res.json({ success: true, data });
  })
);

purchasesRouter.post(
  '/',
  authRequired,
  validate(purchaseSchema),
  asyncHandler(async (req, res) => {
    const data = await createPurchaseOrder(req.body, req.user);
    res.status(201).json({ success: true, data });
  })
);

purchasesRouter.post(
  '/:id/receive',
  authRequired,
  validate(receptionSchema),
  asyncHandler(async (req, res) => {
    const data = await receivePurchaseOrder(Number(req.params.id), req.body, req.user);
    res.status(201).json({ success: true, data });
  })
);
