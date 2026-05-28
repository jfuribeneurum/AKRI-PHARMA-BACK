import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  createBarcodeTraceExport,
  createColdChainExport,
  createControlledExport,
  createDashboardExport,
  createExpirationsExport,
  createInventoryExport,
  createProductImagesExport,
  createPurchasesExport,
  createSalesExport,
  createSiesaBillingExport,
  createDispensingExport
} from '../services/reports.service.js';

export const reportsRouter = Router();

function sendFile(res, file) {
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.buffer);
}

reportsRouter.get(
  '/dashboard/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createDashboardExport(format, req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/inventory/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const search = String(req.query.search ?? '');
    const file = await createInventoryExport(format, search, req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/sales/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const search = String(req.query.search ?? '');
    const file = await createSalesExport(format, search, req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/purchases/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const search = String(req.query.search ?? '');
    const file = await createPurchasesExport(format, search, req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/expirations/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const days = Number(req.query.days ?? 180);
    const file = await createExpirationsExport(format, days, req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/cold-chain/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const hours = Number(req.query.hours ?? 72);
    const file = await createColdChainExport(format, hours, req.user.sub);
    sendFile(res, file);
  })
);


reportsRouter.get(
  '/siesa-billing/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const search = String(req.query.search ?? '');
    const file = await createSiesaBillingExport(format, search, req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/controlled/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const search = String(req.query.search ?? '');
    const days = Number(req.query.days ?? 365);
    const file = await createControlledExport(format, search, days, req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/barcode-trace/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const search = String(req.query.search ?? '');
    const days = Number(req.query.days ?? 30);
    const file = await createBarcodeTraceExport(format, search, days, req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/product-images/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const search = String(req.query.search ?? '');
    const file = await createProductImagesExport(format, search, req.user.sub);
    sendFile(res, file);
  })
);


reportsRouter.get(
  '/dispensing/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const search = String(req.query.search ?? '');
    const file = await createDispensingExport(format, search, req.user.sub);
    sendFile(res, file);
  })
);
