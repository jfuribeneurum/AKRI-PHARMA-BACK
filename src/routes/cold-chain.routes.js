import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { requireRoles } from '../middleware/roles.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  createReading,
  ingestIntegrationReadings,
  listAlerts,
  listEquipment,
  listIntegrations,
  listReadings,
  listRecentAutomaticLogs,
  saveIntegration,
  syncIntegration
} from '../services/cold-chain.service.js';

const readingSchema = z.object({
  id_equipo: z.number().int(),
  temperatura: z.number(),
  humedad: z.number().optional().nullable(),
  fuente: z.enum(['manual', 'sensor', 'api']).optional(),
  observaciones: z.string().optional().nullable()
});

const integrationMappingSchema = z.object({
  id_equipo: z.number().int(),
  device_id: z.string().min(1),
  sensor_label: z.string().optional().nullable(),
  campo_temperatura: z.string().optional().nullable(),
  campo_humedad: z.string().optional().nullable(),
  campo_fecha: z.string().optional().nullable(),
  activo: z.boolean().optional()
});

const integrationSchema = z.object({
  id_integracion: z.number().int().optional().nullable(),
  id_sede: z.number().int(),
  nombre: z.string().min(2),
  protocolo: z.enum(['http_json', 'webhook', 'mqtt_bridge', 'modbus_gateway']).optional(),
  endpoint_url: z.string().optional().nullable(),
  auth_tipo: z.enum(['ninguna', 'bearer', 'basic', 'api_key']).optional(),
  auth_header: z.string().optional().nullable(),
  auth_valor: z.string().optional().nullable(),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  polling_interval_segundos: z.number().int().min(30).max(86400).optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional(),
  activo: z.boolean().optional(),
  metadata: z.record(z.any()).optional().nullable(),
  mappings: z.array(integrationMappingSchema).default([])
});

const ingestSchema = z.object({
  id_integracion: z.number().int(),
  readings: z.union([
    z.array(z.record(z.any())),
    z.record(z.any())
  ])
});

export const coldChainRouter = Router();

coldChainRouter.get(
  '/equipment',
  authRequired,
  asyncHandler(async (_req, res) => {
    const data = await listEquipment();
    res.json({ success: true, data });
  })
);

coldChainRouter.get(
  '/readings',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await listReadings(Number(req.query.limit ?? 150));
    res.json({ success: true, data });
  })
);

coldChainRouter.get(
  '/alerts',
  authRequired,
  asyncHandler(async (_req, res) => {
    const data = await listAlerts();
    res.json({ success: true, data });
  })
);

coldChainRouter.post(
  '/readings',
  authRequired,
  validate(readingSchema),
  asyncHandler(async (req, res) => {
    const data = await createReading(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

coldChainRouter.get(
  '/integrations',
  authRequired,
  asyncHandler(async (_req, res) => {
    const [integrations, logs] = await Promise.all([
      listIntegrations(),
      listRecentAutomaticLogs(25)
    ]);
    res.json({ success: true, data: { integrations, logs } });
  })
);

coldChainRouter.post(
  '/integrations',
  authRequired,
  requireRoles('ADMINISTRADOR', 'QUIMICO_FARMACEUTICO'),
  validate(integrationSchema),
  asyncHandler(async (req, res) => {
    const data = await saveIntegration(req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

coldChainRouter.post(
  '/integrations/:id/sync',
  authRequired,
  requireRoles('ADMINISTRADOR', 'QUIMICO_FARMACEUTICO'),
  asyncHandler(async (req, res) => {
    const data = await syncIntegration(Number(req.params.id), req.user.sub);
    res.json({ success: true, data });
  })
);

coldChainRouter.post(
  '/integrations/ingest',
  validate(ingestSchema),
  asyncHandler(async (req, res) => {
    const data = await ingestIntegrationReadings(req.body, req.user?.sub ?? null);
    res.status(201).json({ success: true, data });
  })
);
