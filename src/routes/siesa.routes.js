import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { getSiesaConfig, upsertSiesaConfig } from '../services/siesa.service.js';

const configSchema = z.object({
  nombre: z.string().optional(),
  api_base_url: z.string().optional().nullable(),
  auth_url: z.string().optional().nullable(),
  invoice_endpoint: z.string().optional(),
  client_id: z.string().optional().nullable(),
  client_secret: z.string().optional().nullable(),
  company_id: z.string().optional().nullable(),
  ambiente: z.enum(['sandbox', 'produccion']).optional(),
  timeout_ms: z.number().int().optional(),
  headers_extra: z.record(z.any()).optional()
});

export const siesaRouter = Router();

siesaRouter.get(
  '/config',
  authRequired,
  asyncHandler(async (_req, res) => {
    const data = await getSiesaConfig();
    res.json({ success: true, data });
  })
);

siesaRouter.post(
  '/config',
  authRequired,
  validate(configSchema),
  asyncHandler(async (req, res) => {
    const normalizedBody = {
      ...req.body,
      api_base_url: req.body.api_base_url || null,
      auth_url: req.body.auth_url || null
    };
    const data = await upsertSiesaConfig(normalizedBody);
    res.json({ success: true, data });
  })
);
