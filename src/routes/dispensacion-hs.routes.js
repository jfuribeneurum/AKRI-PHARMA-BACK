import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  listDispensacionesHS,
  dispensarMedicamento,
  cancelarDispensacion,
  getHistorialEntregas,
  anularEntregaHS
} from '../services/dispensacion-hs.service.js';
import {
  excluirMedicamentoFormulado,
  restaurarMedicamentoExcluido,
  agregarMedicamentoExtra,
  eliminarMedicamentoExtra
} from '../services/formulacion-hs.service.js';

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

// GET /dispensacion-hs/formulacion/:id/historial — entregas ya realizadas
dispensacionHsRouter.get('/formulacion/:id/historial', asyncHandler(async (req, res) => {
  const data = await getHistorialEntregas(Number(req.params.id));
  res.json({ success: true, data });
}));

const dispensarSchema = z.object({
  id_formulacion_hs:     z.number().int().positive(),
  id_med_formulacion_hs: z.number().int().positive(),
  cantidad_dispensada:   z.number().int().min(0).optional(),
  id_producto:           z.number().int().positive().optional().nullable(),
  observaciones:         z.string().max(500).optional().nullable(),
  contrato:              z.string().max(100).optional().nullable(),
  regimen:               z.string().max(100).optional().nullable(),
  // Foto del estado que el operario vio en pantalla al confirmar la entrega,
  // para dejar trazabilidad de cuánto quedaba pendiente/faltante en ese momento.
  // Pendiente = formulada - histórico ya dispensado (antes de esta acción).
  // Faltante  = formulada - lo que se está entregando ahora (esta acción).
  cantidad_pendiente_antes: z.number().int().min(0).optional().nullable(),
  cantidad_faltante:        z.number().int().min(0).optional().nullable(),
  // Sobrescritura manual y libre del acumulado de "Cant. dispensada" desde el modal.
  cantidad_dispensada_total_override: z.number().int().min(0).optional().nullable(),
  // Lotes elegidos para cubrir "Control de entrega" — de dónde sale físicamente
  // el inventario. Obligatorio cuando cantidad_dispensada > 0 (se valida en el service).
  lotes: z.array(z.object({
    id_lote:      z.number().int().positive(),
    id_ubicacion: z.number().int().positive(),
    cantidad:     z.number().int().positive()
  })).optional()
});

// POST /dispensacion-hs — dispensar o actualizar un medicamento de una formulación
dispensacionHsRouter.post('/', validate(dispensarSchema), asyncHandler(async (req, res) => {
  const userId = req.user?.sub ?? null;
  const record = await dispensarMedicamento(req.body, userId, req.user?.id_sede ?? null);
  res.status(201).json({ success: true, data: record });
}));

// DELETE /dispensacion-hs/:id — cancelar
dispensacionHsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const userId = req.user?.sub ?? null;
  const result = await cancelarDispensacion(Number(req.params.id), userId, req.user?.id_sede ?? null);
  res.json({ success: true, data: result });
}));

// POST /dispensacion-hs/movimiento/:id/anular — anular una entrega puntual
// del histórico: repone el inventario descontado y la cantidad vuelve a
// quedar pendiente por entregar, dejando trazabilidad del usuario que anuló.
dispensacionHsRouter.post('/movimiento/:id/anular', asyncHandler(async (req, res) => {
  const userId = req.user?.sub ?? null;
  const result = await anularEntregaHS(Number(req.params.id), userId, req.user?.id_sede ?? null);
  res.json({ success: true, data: result });
}));

const excluirSchema = z.object({
  nombre_medicamento: z.string().max(255).optional().nullable(),
  motivo:             z.string().max(255).optional().nullable()
});

// POST /dispensacion-hs/formulacion/:id/medicamentos/:idMed/excluir — quita un
// medicamento formulado (en HealthSphere) de la vista de dispensación, sin
// tocar el registro origen (solo lectura).
dispensacionHsRouter.post('/formulacion/:id/medicamentos/:idMed/excluir', validate(excluirSchema), asyncHandler(async (req, res) => {
  const userId = req.user?.sub ?? null;
  const result = await excluirMedicamentoFormulado(
    Number(req.params.id),
    Number(req.params.idMed),
    req.body.nombre_medicamento ?? null,
    userId,
    req.body.motivo ?? null,
    req.user?.id_sede ?? null
  );
  res.json({ success: true, data: result });
}));

// DELETE /dispensacion-hs/formulacion/:id/medicamentos/:idMed/excluir — deshace la exclusión.
dispensacionHsRouter.delete('/formulacion/:id/medicamentos/:idMed/excluir', asyncHandler(async (req, res) => {
  const userId = req.user?.sub ?? null;
  const result = await restaurarMedicamentoExcluido(Number(req.params.id), Number(req.params.idMed), userId, req.user?.id_sede ?? null);
  res.json({ success: true, data: result });
}));

const medicamentoExtraSchema = z.object({
  id_producto:        z.number().int().positive(),
  presentacion:       z.string().max(120).optional().nullable(),
  via_administracion: z.string().max(120).optional().nullable(),
  cantidad:           z.number().positive(),
  diagnostico:        z.string().max(255).optional().nullable(),
  observaciones:      z.string().max(255).optional().nullable()
});

// POST /dispensacion-hs/formulacion/:id/medicamentos-extra — agrega un
// medicamento manual a la formulación (no existe en HealthSphere).
dispensacionHsRouter.post('/formulacion/:id/medicamentos-extra', validate(medicamentoExtraSchema), asyncHandler(async (req, res) => {
  const userId = req.user?.sub ?? null;
  const result = await agregarMedicamentoExtra(Number(req.params.id), req.body, userId, req.user?.id_sede ?? null);
  res.status(201).json({ success: true, data: result });
}));

// DELETE /dispensacion-hs/medicamentos-extra/:id — elimina (soft delete) un medicamento manual.
dispensacionHsRouter.delete('/medicamentos-extra/:id', asyncHandler(async (req, res) => {
  const userId = req.user?.sub ?? null;
  const result = await eliminarMedicamentoExtra(Number(req.params.id), userId, req.user?.id_sede ?? null);
  res.json({ success: true, data: result });
}));
