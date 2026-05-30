import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { listFormulacionesHS, getFormulacionHSById } from '../services/formulacion-hs.service.js';
import { getControlByFormulacion, getControlStatusBatch } from '../services/dispensacion-hs.service.js';

export const formulacionHsRouter = Router();

formulacionHsRouter.use(authRequired);

// GET /formulaciones-hs?search=&page=&limit=
formulacionHsRouter.get('/', asyncHandler(async (req, res) => {
  const search     = String(req.query.search ?? '').trim();
  const page       = Math.max(1, Number(req.query.page ?? 1));
  const limit      = Math.min(100, Math.max(5, Number(req.query.limit ?? 30)));
  const fechaDesde = String(req.query.fechaDesde ?? '').trim();
  const fechaHasta = String(req.query.fechaHasta ?? '').trim();

  const result = await listFormulacionesHS({ search, page, limit, fechaDesde, fechaHasta });

  // Enriquecer con estado de control de dispensación
  if (result.data.length) {
    const ids = result.data.map(r => r.id_formulacion);
    const statusRows = await getControlStatusBatch(ids);
    const statusMap = Object.fromEntries(statusRows.map(s => [s.id_formulacion_hs, s]));
    result.data = result.data.map(f => ({
      ...f,
      control: statusMap[f.id_formulacion] ?? null
    }));
  }

  res.json({ success: true, ...result });
}));

// GET /formulaciones-hs/:id
formulacionHsRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const formulacion = await getFormulacionHSById(id);

  if (!formulacion) {
    return res.status(404).json({ success: false, message: 'Formulación no encontrada' });
  }

  const controlRows = await getControlByFormulacion(id);
  const controlMap = Object.fromEntries(controlRows.map(c => [c.id_med_formulacion_hs, c]));

  formulacion.medicamentos = formulacion.medicamentos.map(m => ({
    ...m,
    control: controlMap[m.id_med_formulacion] ?? null
  }));

  res.json({ success: true, data: formulacion });
}));
