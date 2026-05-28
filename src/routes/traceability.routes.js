import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { listProcessTrace } from '../services/traceability.service.js';

export const traceabilityRouter = Router();
traceabilityRouter.use(authRequired);

traceabilityRouter.get(
  '/processes',
  asyncHandler(async (req, res) => {
    const data = await listProcessTrace({
      id_sede: req.query.id_sede ? Number(req.query.id_sede) : null,
      id_usuario: req.query.id_usuario ? Number(req.query.id_usuario) : null,
      proceso: req.query.proceso ? String(req.query.proceso) : '',
      subproceso: req.query.subproceso ? String(req.query.subproceso) : '',
      date_from: req.query.date_from ? String(req.query.date_from) : '',
      date_to: req.query.date_to ? String(req.query.date_to) : '',
      search: String(req.query.search ?? ''),
      limit: Number(req.query.limit ?? 100)
    });
    res.json({ success: true, data });
  })
);
