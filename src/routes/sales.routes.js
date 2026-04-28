import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { listSales, createSale } from '../services/sale.service.js';

const saleItemSchema = z.object({
  id_lote: z.number().int(),
  cantidad: z.number().positive(),
  precio_unitario: z.number().nonnegative(),
  impuesto: z.number().optional(),
  descuento: z.number().optional(),
  doble_verificacion_por: z.number().int().optional().nullable()
});

const saleSchema = z.object({
  folio_venta: z.string().min(2),
  tipo: z.enum(['mostrador', 'credito', 'institucional']).optional(),
  id_cliente: z.number().int().optional().nullable(),
  id_paciente: z.number().int().optional().nullable(),
  id_medico: z.number().int().optional().nullable(),
  id_receta: z.number().int().optional().nullable(),
  receta_folio: z.string().optional().nullable(),
  metodo_pago: z.string().optional(),
  requiere_factura: z.boolean().optional(),
  items: z.array(saleItemSchema).min(1)
});

export const salesRouter = Router();

salesRouter.get(
  '/',
  authRequired,
  asyncHandler(async (_req, res) => {
    const data = await listSales();
    res.json({ success: true, data });
  })
);

salesRouter.post(
  '/',
  authRequired,
  validate(saleSchema),
  asyncHandler(async (req, res) => {
    const data = await createSale(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);
