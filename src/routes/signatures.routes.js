import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { getSignatureProfile, listRecentSignatures, signProcess, upsertSignatureProfile } from '../services/signature.service.js';

const profileSchema = z.object({
  alias_certificado: z.string().min(3),
  emisor_certificado: z.string().optional().nullable(),
  serial_certificado: z.string().optional().nullable(),
  huella_certificado: z.string().optional().nullable(),
  email_firma: z.string().email().optional().nullable(),
  pin: z.string().min(4).optional().nullable(),
  exige_segundo_factor: z.boolean().optional(),
  firma_visible_nombre: z.string().optional().nullable(),
  firma_visible_cargo: z.string().optional().nullable(),
  firma_visible_imagen: z.string().optional().nullable(),
  es_activo: z.boolean().optional(),
  metadata: z.record(z.any()).optional()
});

const signSchema = z.object({
  request_id: z.string().uuid().optional().nullable(),
  modulo: z.string().min(2),
  submodulo: z.string().optional().nullable(),
  referencia_tipo: z.string().optional().nullable(),
  referencia_id: z.union([z.number().int(), z.string()]).optional().nullable(),
  descripcion: z.string().optional().nullable(),
  evidencia: z.record(z.any()).optional().nullable(),
  secret: z.string().min(4)
});

export const signaturesRouter = Router();
signaturesRouter.use(authRequired);

signaturesRouter.get('/profile', asyncHandler(async (req, res) => {
  const data = await getSignatureProfile(req.user.sub);
  res.json({ success: true, data });
}));

signaturesRouter.put('/profile', validate(profileSchema), asyncHandler(async (req, res) => {
  const data = await upsertSignatureProfile(req.body, req.user);
  res.json({ success: true, data });
}));

signaturesRouter.post('/sign', validate(signSchema), asyncHandler(async (req, res) => {
  const data = await signProcess(req.body, req.user);
  res.status(201).json({ success: true, data });
}));

signaturesRouter.get('/recent', asyncHandler(async (req, res) => {
  const data = await listRecentSignatures(Number(req.query.limit ?? 20));
  res.json({ success: true, data });
}));
