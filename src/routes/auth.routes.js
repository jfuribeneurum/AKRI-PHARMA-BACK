import { Router } from 'express';
import { z } from 'zod';
import { login, selectSiteSession, selectAlmacenSession, getSedeAlmacenes } from '../services/auth.service.js';
import { asyncHandler } from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { authRequired } from '../middleware/auth.js';

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  id_sede: z.number().int().positive().optional().nullable()
});

const selectSiteSchema = z.object({
  id_sede: z.number().int().positive()
});

const selectAlmacenSchema = z.object({
  id_almacen: z.number().int().positive()
});

export const authRouter = Router();

authRouter.post(
  '/login',
  validate(schema),
  asyncHandler(async (req, res) => {
    const result = await login(req.body);
    res.json({
      success: true,
      data: result
    });
  })
);

authRouter.post(
  '/select-site',
  authRequired,
  validate(selectSiteSchema),
  asyncHandler(async (req, res) => {
    const result = await selectSiteSession({ userId: req.user.sub, id_sede: req.body.id_sede });
    res.json({ success: true, data: result });
  })
);

authRouter.post(
  '/select-almacen',
  authRequired,
  validate(selectAlmacenSchema),
  asyncHandler(async (req, res) => {
    const result = await selectAlmacenSession({ userId: req.user.sub, id_almacen: req.body.id_almacen });
    res.json({ success: true, data: result });
  })
);

authRouter.get(
  '/almacenes',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await getSedeAlmacenes(req.user.id_sede);
    res.json({ success: true, data });
  })
);
