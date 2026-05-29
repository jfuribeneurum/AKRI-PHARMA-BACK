import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  listDispensacionesHS,
  dispensarMedicamento,
  cancelarDispensacion
} from '../services/dispensacion-hs.service.js';

export const dispensacionHsRouter = Router();

dispensacionHsRouter.use(authRequired);

// GET /dispensacion-hs?search=&estado=&page=&limit=
dispensacionHsRouter.get('/', asyncHandler(async (req, res) => {
  const search = String(req.query.search ?? '').trim();
  const estado = String(req.query.estado ?? '').trim();
  const page   = Math.max(1, Number(req.query.page ?? 1));
  const limit  = Math.min(100, Math.max(5, Number(req.query.limit ?? 50)));

  const data = await listDispensacionesHS({ search, estado, page, limit });
  res.json({ success: true, data });
}));

const dispensarSchema = z.object({
  id_formulacion_hs:     z.number().int().positive(),
  id_med_formulacion_hs: z.number().int().positive(),
  cantidad_dispensada:   z.number().int().min(0).optional(),
  id_producto:           z.number().int().positive().optional().nullable(),
  observaciones:         z.string().max(500).optional().nullable()
});

// POST /dispensacion-hs — dispensar o actualizar un medicamento de una formulación
dispensacionHsRouter.post('/', validate(dispensarSchema), asyncHandler(async (req, res) => {
  const userId = req.user?.id_usuario ?? null;
  const record = await dispensarMedicamento(req.body, userId);
  res.status(201).json({ success: true, data: record });
}));

// DELETE /dispensacion-hs/:id — cancelar
dispensacionHsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const userId = req.user?.id_usuario ?? null;
  const result = await cancelarDispensacion(Number(req.params.id), userId);
  res.json({ success: true, data: result });
}));
