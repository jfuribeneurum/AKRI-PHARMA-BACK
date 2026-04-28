import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { listInvoices, createInvoiceFromSale } from '../services/billing.service.js';
import { submitInvoiceToSiesa } from '../services/siesa.service.js';

const createInvoiceSchema = z.object({
  id_venta: z.number().int()
});

export const billingRouter = Router();

billingRouter.get(
  '/invoices',
  authRequired,
  asyncHandler(async (_req, res) => {
    const data = await listInvoices();
    res.json({ success: true, data });
  })
);

billingRouter.post(
  '/invoices',
  authRequired,
  validate(createInvoiceSchema),
  asyncHandler(async (req, res) => {
    const data = await createInvoiceFromSale(req.body.id_venta);
    res.status(201).json({ success: true, data });
  })
);

billingRouter.post(
  '/invoices/:id/submit-siesa',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await submitInvoiceToSiesa(Number(req.params.id));
    res.json({ success: true, data });
  })
);
