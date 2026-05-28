import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { listProviders, createProvider, updateProvider } from '../services/providers.service.js';

export const providersRouter = Router();

providersRouter.use(authRequired);

providersRouter.get('/', asyncHandler(async (_req, res) => {
  const data = await listProviders();
  res.json({ success: true, data });
}));

const providerSchema = z.object({
  codigo: z.string().optional().nullable(),
  tipo_identificacion: z.enum(['NIT', 'CC', 'CE', 'Pasaporte']).default('NIT'),
  numero_identificacion: z.string().min(1),
  digito_verificacion: z.string().max(2).optional().nullable(),
  razon_social: z.string().min(1),
  nombres: z.string().optional().nullable(),
  apellidos: z.string().optional().nullable(),
  telefono: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  ciudad: z.string().optional().nullable(),
  direccion: z.string().optional().nullable(),
  activo: z.boolean().optional()
});

providersRouter.post('/', validate(providerSchema), asyncHandler(async (req, res) => {
  const result = await createProvider(req.body);
  res.status(201).json({ success: true, data: result });
}));

providersRouter.put('/:id', validate(providerSchema), asyncHandler(async (req, res) => {
  await updateProvider(Number(req.params.id), req.body);
  res.json({ success: true });
}));
