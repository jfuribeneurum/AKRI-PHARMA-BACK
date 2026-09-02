import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { listFormulacionesHS, getFormulacionHSById, getExclusionYExtraCounts } from '../services/formulacion-hs.service.js';
import { getControlByFormulacion, getControlStatusBatch } from '../services/dispensacion-hs.service.js';

export const formulacionHsRouter = Router();

formulacionHsRouter.use(authRequired);

const VALID_ESTADOS = new Set(['pendiente', 'parcial', 'dispensado']);

// Replica exacta de getResumenLabel del frontend para filtrar en el backend
function computeEstado(f) {
  const c = f.control;
  if (!c || (Number(c.dispensados) === 0 && Number(c.parciales) === 0)) return 'pendiente';
  if (Number(c.dispensados) >= Number(f.total_medicamentos)) return 'dispensado';
  return 'parcial';
}

// GET /formulaciones-hs?search=&page=&limit=&estado=&fechaDesde=&fechaHasta=
formulacionHsRouter.get('/', asyncHandler(async (req, res) => {
  const search     = String(req.query.search ?? '').trim();
  const page       = Math.max(1, Number(req.query.page ?? 1));
  const limit      = Math.min(100, Math.max(5, Number(req.query.limit ?? 30)));
  const fechaDesde = String(req.query.fechaDesde ?? '').trim();
  const fechaHasta = String(req.query.fechaHasta ?? '').trim();
  const estado     = VALID_ESTADOS.has(String(req.query.estado ?? '').trim())
    ? String(req.query.estado).trim()
    : '';

  // Cuando hay filtro de estado, traemos todo el conjunto (sin paginación HS)
  // porque el estado vive en la BD local y hay que calcular cuántas quedan después de filtrar.
  const hsLimit  = estado ? 2000 : limit;
  const hsPage   = estado ? 1    : page;

  const result = await listFormulacionesHS({ search, page: hsPage, limit: hsLimit, fechaDesde, fechaHasta });

  // Enriquecer con estado de control de dispensación (BD local)
  let enriched = result.data;
  if (enriched.length) {
    const ids = enriched.map(r => r.id_formulacion);
    const [statusRows, ajusteCounts] = await Promise.all([
      getControlStatusBatch(ids),
      getExclusionYExtraCounts(ids)
    ]);
    const statusMap = Object.fromEntries(statusRows.map(s => [s.id_formulacion_hs, s]));
    enriched = enriched.map(f => {
      const ajuste = ajusteCounts[f.id_formulacion] ?? { excluidos: 0, extras: 0 };
      return {
        ...f,
        // total_medicamentos crudo de HealthSphere no cuenta exclusiones ni
        // medicamentos manuales — se corrige aquí para que el estado agregado
        // (y su filtro) reflejen lo que el usuario realmente ve/dispensa.
        total_medicamentos: Math.max(0, Number(f.total_medicamentos) - ajuste.excluidos + ajuste.extras),
        control: statusMap[f.id_formulacion] ?? null
      };
    });
  }

  // Filtrar por estado y paginar en memoria
  if (estado) {
    enriched = enriched.filter(f => computeEstado(f) === estado);
    const total  = enriched.length;
    const offset = (page - 1) * limit;
    const data   = enriched.slice(offset, offset + limit);
    return res.json({ success: true, data, total, page, limit });
  }

  res.json({ success: true, data: enriched, total: result.total, page, limit });
}));

// GET /formulaciones-hs/:id
formulacionHsRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const formulacion = await getFormulacionHSById(id, req.user?.id_sede ?? null);

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
