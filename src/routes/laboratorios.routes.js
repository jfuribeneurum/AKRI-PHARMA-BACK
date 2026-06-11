import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { listLaboratorios, createLaboratorio, updateLaboratorio } from '../services/laboratorios.service.js';

export const laboratoriosRouter = Router();

laboratoriosRouter.use(authRequired);

laboratoriosRouter.get('/', asyncHandler(async (_req, res) => {
  const data = await listLaboratorios();
  res.json({ success: true, data });
}));

const labSchema = z.object({
  nombre: z.string().min(1),
  activo: z.boolean().optional(),
});

laboratoriosRouter.post('/', validate(labSchema), asyncHandler(async (req, res) => {
  const result = await createLaboratorio(req.body);
  res.status(201).json({ success: true, data: result });
}));

laboratoriosRouter.put('/:id', validate(labSchema), asyncHandler(async (req, res) => {
  await updateLaboratorio(Number(req.params.id), req.body);
  res.json({ success: true });
}));
