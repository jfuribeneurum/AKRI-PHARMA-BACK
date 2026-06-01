import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  createTraslado,
  listTraslados,
  recibirTraslado,
  rechazarTraslado
} from '../services/traslados.service.js';

const crearSchema = z.object({
  id_lote:              z.number().int(),
  id_producto:          z.number().int().optional(),
  id_almacen_origen:    z.number().int(),
  id_ubicacion_origen:  z.number().int(),
  id_almacen_destino:   z.number().int(),
  id_ubicacion_destino: z.number().int(),
  cantidad:             z.number().positive(),
  motivo:               z.string().optional().nullable()
});

const recibirSchema = z.object({
  observaciones: z.string().optional().nullable()
});

const rechazarSchema = z.object({
  motivo: z.string().optional().nullable()
});

export const trasladosRouter = Router();

trasladosRouter.get(
  '/',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await listTraslados({
      estado:              req.query.estado ? String(req.query.estado) : undefined,
      id_almacen_destino:  req.query.id_almacen_destino ? Number(req.query.id_almacen_destino) : undefined,
      id_almacen_origen:   req.query.id_almacen_origen  ? Number(req.query.id_almacen_origen)  : undefined
    });
    res.json({ success: true, data });
  })
);

trasladosRouter.post(
  '/',
  authRequired,
  validate(crearSchema),
  asyncHandler(async (req, res) => {
    const data = await createTraslado(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

trasladosRouter.patch(
  '/:id/recibir',
  authRequired,
  validate(recibirSchema),
  asyncHandler(async (req, res) => {
    const data = await recibirTraslado(Number(req.params.id), req.user.sub, req.body.observaciones);
    res.json({ success: true, data });
  })
);

trasladosRouter.patch(
  '/:id/rechazar',
  authRequired,
  validate(rechazarSchema),
  asyncHandler(async (req, res) => {
    const data = await rechazarTraslado(Number(req.params.id), req.user.sub, req.body.motivo);
    res.json({ success: true, data });
  })
);
