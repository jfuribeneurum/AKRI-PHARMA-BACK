import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { requireRoles } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  createDispensation,
  createDomiciliary,
  deleteDomiciliary,
  listAvailableDispensingItems,
  listDispensations,
  listDispensingLookups,
  listDomiciliaries
} from '../services/dispensing.service.js';
import {
  createDispensingRequest,
  createDispensingRequestFromPrescriptionScan,
  fulfillDispensingRequest,
  getDispensingRequestById,
  importDispensingRequestFromEhr,
  listDispensingRequests
} from '../services/dispensing-request.service.js';

const domiciliarySchema = z.object({
  nombre: z.string().min(2),
  apellido: z.string().min(2),
  cedula: z.string().min(4),
  telefono: z.string().min(6),
  sexo: z.enum(['M', 'F', 'O']).optional()
});

const dispensingItemSchema = z.object({
  id_lote: z.number().int(),
  cantidad: z.number().positive(),
  temperatura_entrega: z.number().optional().nullable()
});

const patientSchema = z.object({
  id_paciente: z.number().int().optional().nullable(),
  nombre: z.string().min(2),
  documento: z.string().min(4),
  direccion: z.string().min(4),
  telefono: z.string().min(6),
  genero: z.enum(['M', 'F', 'O']).optional()
});

const signatureSchema = z.object({
  tipo: z.enum(['domiciliario', 'paciente', 'representante']),
  nombre: z.string().min(2),
  data_url: z.string().min(50)
});


const requestItemSchema = z.object({
  id_producto: z.number().int().optional().nullable(),
  descripcion_libre: z.string().min(2),
  dosis: z.string().optional().nullable(),
  via_administracion: z.string().optional().nullable(),
  frecuencia: z.string().optional().nullable(),
  duracion: z.string().optional().nullable(),
  cantidad_solicitada: z.number().positive(),
  observaciones: z.string().optional().nullable()
});

const dispensingRequestSchema = z.object({
  consecutivo: z.string().optional().nullable(),
  id_sede: z.number().int(),
  id_almacen_sugerido: z.number().int().optional().nullable(),
  referencia_externa: z.string().optional().nullable(),
  observaciones: z.string().optional().nullable(),
  paciente: patientSchema,
  items: z.array(requestItemSchema).min(1)
});

const ehrImportSchema = dispensingRequestSchema.extend({
  payload_origen: z.record(z.any()).optional().nullable()
});

const prescriptionScanSchema = dispensingRequestSchema.extend({
  archivo_nombre: z.string().min(3),
  archivo_data_url: z.string().min(50),
  payload_origen: z.record(z.any()).optional().nullable()
});

const fulfillRequestSchema = z.object({
  id_sede: z.number().int().optional(),
  id_almacen: z.number().int(),
  id_domiciliario: z.number().int().optional().nullable(),
  usar_domiciliario_receptor: z.boolean().optional(),
  receptor_tipo: z.enum(['domiciliario', 'paciente', 'representante']).optional(),
  receptor_nombre: z.string().optional().nullable(),
  receptor_documento: z.string().optional().nullable(),
  receptor_telefono: z.string().optional().nullable(),
  receta_folio: z.string().optional().nullable(),
  observaciones: z.string().optional().nullable(),
  temperatura_entrega: z.number().optional().nullable(),
  default_id_lote: z.number().int().optional().nullable(),
  item_lot_map: z.record(z.string(), z.number().int()).optional(),
  firma: signatureSchema
});

const dispensingSchema = z.object({
  consecutivo: z.string().optional().nullable(),
  id_sede: z.number().int(),
  id_almacen: z.number().int(),
  id_domiciliario: z.number().int().optional().nullable(),
  usar_domiciliario_receptor: z.boolean().optional(),
  receptor_tipo: z.enum(['domiciliario', 'paciente', 'representante']).optional(),
  receptor_nombre: z.string().optional().nullable(),
  receptor_documento: z.string().optional().nullable(),
  receptor_telefono: z.string().optional().nullable(),
  receta_folio: z.string().optional().nullable(),
  observaciones: z.string().optional().nullable(),
  paciente: patientSchema,
  firma: signatureSchema,
  items: z.array(dispensingItemSchema).min(1)
});

export const dispensingRouter = Router();

dispensingRouter.use(authRequired);

dispensingRouter.get(
  '/lookups',
  asyncHandler(async (_req, res) => {
    const data = await listDispensingLookups();
    res.json({ success: true, data });
  })
);

dispensingRouter.get(
  '/catalog',
  asyncHandler(async (req, res) => {
    const data = await listAvailableDispensingItems(
      String(req.query.search ?? ''),
      req.query.id_sede ? Number(req.query.id_sede) : null
    );
    res.json({ success: true, data });
  })
);

dispensingRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const data = await listDispensations(String(req.query.search ?? ''));
    res.json({ success: true, data });
  })
);



dispensingRouter.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const data = await listDispensingRequests(String(req.query.search ?? ''), String(req.query.status ?? ''));
    res.json({ success: true, data });
  })
);

dispensingRouter.get(
  '/requests/:id',
  asyncHandler(async (req, res) => {
    const data = await getDispensingRequestById(Number(req.params.id));
    res.json({ success: true, data });
  })
);

dispensingRouter.post(
  '/requests',
  validate(dispensingRequestSchema),
  asyncHandler(async (req, res) => {
    const data = await createDispensingRequest(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

dispensingRouter.post(
  '/requests/import/ehr',
  validate(ehrImportSchema),
  asyncHandler(async (req, res) => {
    const data = await importDispensingRequestFromEhr(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

dispensingRouter.post(
  '/requests/import/prescription-scan',
  validate(prescriptionScanSchema),
  asyncHandler(async (req, res) => {
    const data = await createDispensingRequestFromPrescriptionScan(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

dispensingRouter.post(
  '/requests/:id/fulfill',
  validate(fulfillRequestSchema),
  asyncHandler(async (req, res) => {
    const data = await fulfillDispensingRequest(Number(req.params.id), req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

dispensingRouter.get(
  '/domiciliaries',
  asyncHandler(async (req, res) => {
    const data = await listDomiciliaries(
      String(req.query.search ?? ''),
      String(req.query.include_inactive ?? 'false') === 'true'
    );
    res.json({ success: true, data });
  })
);

dispensingRouter.post(
  '/domiciliaries',
  validate(domiciliarySchema),
  asyncHandler(async (req, res) => {
    const data = await createDomiciliary(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

dispensingRouter.delete(
  '/domiciliaries/:id',
  requireRoles('ADMINISTRADOR'),
  asyncHandler(async (req, res) => {
    const data = await deleteDomiciliary(Number(req.params.id), req.user.sub);
    res.json({ success: true, data });
  })
);

dispensingRouter.post(
  '/',
  validate(dispensingSchema),
  asyncHandler(async (req, res) => {
    const data = await createDispensation(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);
