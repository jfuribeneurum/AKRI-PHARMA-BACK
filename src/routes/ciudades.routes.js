import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  listCiudades,
  listDepartamentos,
  getCiudadById,
  createCiudad,
  updateCiudad,
  toggleCiudad
} from '../services/ciudades.service.js';

export const ciudadesRouter = Router();

ciudadesRouter.use(authRequired);

ciudadesRouter.get('/', asyncHandler(async (req, res) => {
  const search       = String(req.query.search ?? '').trim();
  const departamento = String(req.query.departamento ?? '').trim();
  const soloActivas  = req.query.soloActivas === 'true';
  const page         = Math.max(1, Number(req.query.page ?? 1));
  const limit        = Math.min(200, Math.max(10, Number(req.query.limit ?? 50)));

  const result = await listCiudades({ search, departamento, soloActivas, page, limit });
  res.json({ success: true, ...result });
}));

ciudadesRouter.get('/departamentos', asyncHandler(async (_req, res) => {
  const rows = await listDepartamentos();
  res.json({ success: true, data: rows.map(r => r.departamento) });
}));

ciudadesRouter.get('/:id', asyncHandler(async (req, res) => {
  const ciudad = await getCiudadById(Number(req.params.id));
  if (!ciudad) return res.status(404).json({ success: false, message: 'Ciudad no encontrada' });
  res.json({ success: true, data: ciudad });
}));

const ciudadSchema = z.object({
  nombre:       z.string().min(1).max(120),
  departamento: z.string().min(1).max(80),
  codigo_dane:  z.string().max(5).optional().nullable(),
  activo:       z.boolean().optional()
});

ciudadesRouter.post('/', validate(ciudadSchema), asyncHandler(async (req, res) => {
  const result = await createCiudad(req.body);
  res.status(201).json({ success: true, data: result });
}));

ciudadesRouter.put('/:id', validate(ciudadSchema), asyncHandler(async (req, res) => {
  await updateCiudad(Number(req.params.id), req.body);
  res.json({ success: true });
}));

ciudadesRouter.patch('/:id/toggle', asyncHandler(async (req, res) => {
  const result = await toggleCiudad(Number(req.params.id));
  res.json({ success: true, data: result });
}));
