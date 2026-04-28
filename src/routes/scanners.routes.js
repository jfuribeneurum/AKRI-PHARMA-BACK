import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { createScannerProfile, listScannerCatalog, listScannerProfiles, updateScannerProfile } from '../services/scanner.service.js';

const scannerProfileSchema = z.object({
  id_sede: z.number().int(),
  nombre: z.string().min(2),
  canal_preferido: z.enum(['keyboard_wedge','webhid','webserial','webusb','camera','image_upload','manual']).optional(),
  tipo_scanner: z.enum(['lapiz_optico','ranura','ccd','imagen','laser_pistola','generic_wedge','desconocido']).optional(),
  forma_uso: z.enum(['pistola','fijo','mesa','portatil','wearable','desconocida']).optional(),
  vendor_id: z.string().optional().nullable(),
  product_id: z.string().optional().nullable(),
  serial_number: z.string().optional().nullable(),
  patron_entrada: z.string().optional().nullable(),
  teclado_sufijo: z.string().optional().nullable(),
  activo: z.boolean().optional(),
  metadata: z.record(z.any()).optional().nullable()
});

export const scannersRouter = Router();
scannersRouter.use(authRequired);

scannersRouter.get('/catalog', asyncHandler(async (_req, res) => {
  const data = await listScannerCatalog();
  res.json({ success: true, data });
}));

scannersRouter.get('/profiles', asyncHandler(async (req, res) => {
  const data = await listScannerProfiles(req.query.id_sede ? Number(req.query.id_sede) : null);
  res.json({ success: true, data });
}));

scannersRouter.post('/profiles', validate(scannerProfileSchema), asyncHandler(async (req, res) => {
  const data = await createScannerProfile(req.body, req.user.sub);
  res.status(201).json({ success: true, data });
}));

scannersRouter.put('/profiles/:id', validate(scannerProfileSchema.partial()), asyncHandler(async (req, res) => {
  const data = await updateScannerProfile(Number(req.params.id), req.body);
  res.json({ success: true, data });
}));
