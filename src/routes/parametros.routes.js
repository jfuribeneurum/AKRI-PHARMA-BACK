import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  listGrupos,
  listByGrupo,
  listActivosByGrupo,
  getParametroById,
  createParametro,
  updateParametro,
  toggleParametro,
  deleteParametro
} from '../services/parametros.service.js';

export const parametrosRouter = Router();

parametrosRouter.use(authRequired);

parametrosRouter.get('/grupos', asyncHandler(async (_req, res) => {
  const data = await listGrupos();
  res.json({ success: true, data });
}));

parametrosRouter.get('/:grupo', asyncHandler(async (req, res) => {
  const data = await listByGrupo(req.params.grupo);
  res.json({ success: true, data });
}));

parametrosRouter.get('/:grupo/activos', asyncHandler(async (req, res) => {
  const data = await listActivosByGrupo(req.params.grupo);
  res.json({ success: true, data });
}));

const createSchema = z.object({
  grupo:       z.string().min(1).max(80),
  grupo_label: z.string().max(120).optional(),
  valor:       z.string().min(1).max(200),
  etiqueta:    z.string().min(1).max(200),
  orden:       z.number().int().optional()
});

const updateSchema = z.object({
  etiqueta: z.string().min(1).max(200),
  orden:    z.number().int().optional()
});

parametrosRouter.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const result = await createParametro(req.body);
  res.status(201).json({ success: true, data: result });
}));

parametrosRouter.put('/:id', validate(updateSchema), asyncHandler(async (req, res) => {
  await updateParametro(Number(req.params.id), req.body);
  res.json({ success: true });
}));

parametrosRouter.patch('/:id/toggle', asyncHandler(async (req, res) => {
  const result = await toggleParametro(Number(req.params.id));
  res.json({ success: true, data: result });
}));

parametrosRouter.delete('/:id', asyncHandler(async (req, res) => {
  await deleteParametro(Number(req.params.id));
  res.json({ success: true });
}));
