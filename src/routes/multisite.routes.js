import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  createPurchaseRequestFromBranch,
  getMultisiteContext,
  getPurchaseRequestById,
  listPurchaseRequests,
  updatePurchaseRequestStatus
} from '../services/multisite.service.js';

const requestItemSchema = z.object({
  id_solicitud_compra_detalle: z.number().int().positive().optional(),
  id_producto: z.number().int().positive().optional().nullable(),
  descripcion_item: z.string().min(2).optional(),
  nombre_comercial: z.string().min(2).optional(),
  cantidad_solicitada: z.number().positive(),
  observaciones: z.string().optional().nullable()
});

const createRequestSchema = z.object({
  id_sede_origen: z.number().int().positive().optional(),
  prioridad: z.enum(['baja', 'media', 'alta', 'critica']).optional(),
  observaciones: z.string().optional().nullable(),
  id_sede_origen: z.number().int().positive().optional(),
  items: z.array(requestItemSchema).min(1),
  metadata: z.record(z.any()).optional().nullable()
});

const updateRequestSchema = z.object({
  estado: z.enum(['revisada', 'aprobada', 'rechazada', 'atendida', 'cancelada']),
  observaciones: z.string().optional().nullable(),
  accion: z.string().optional().nullable(),
  items: z.array(requestItemSchema).optional()
});

export const multisiteRouter = Router();
multisiteRouter.use(authRequired);

multisiteRouter.get(
  '/context',
  asyncHandler(async (req, res) => {
    const data = await getMultisiteContext(req.user);
    res.json({ success: true, data });
  })
);

multisiteRouter.get(
  '/purchase-requests',
  asyncHandler(async (req, res) => {
    const data = await listPurchaseRequests({
      status: req.query.status,
      search: req.query.search,
      scope: req.query.scope,
      id_sede_origen: req.query.id_sede_origen ? Number(req.query.id_sede_origen) : null
    }, req.user);
    res.json({ success: true, data });
  })
);

multisiteRouter.get(
  '/purchase-requests/:id',
  asyncHandler(async (req, res) => {
    const data = await getPurchaseRequestById(Number(req.params.id), req.user);
    res.json({ success: true, data });
  })
);

multisiteRouter.post(
  '/purchase-requests',
  validate(createRequestSchema),
  asyncHandler(async (req, res) => {
    const data = await createPurchaseRequestFromBranch(req.body, req.user);
    res.status(201).json({ success: true, data });
  })
);

multisiteRouter.patch(
  '/purchase-requests/:id',
  validate(updateRequestSchema),
  asyncHandler(async (req, res) => {
    const data = await updatePurchaseRequestStatus(Number(req.params.id), req.body, req.user);
    res.json({ success: true, data });
  })
);
