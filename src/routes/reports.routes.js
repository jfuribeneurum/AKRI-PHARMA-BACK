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
  createDispensingExport,
  createEntradasExport,
  createSalidasExport,
  createIngresosExport,
  createDevolucionesExport,
  createActasExport,
  createMaestroExport,
  createProductMovementsExport,
  createRipsAmExport,
  createPendientesExport
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
    const idSede = req.query.id_sede ? Number(req.query.id_sede) : null;
    const file = await createInventoryExport(format, search, req.user.sub, idSede);
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
    const desde = req.query.desde ? String(req.query.desde) : null;
    const hasta = req.query.hasta ? String(req.query.hasta) : null;
    const idSede = req.query.id_sede ? Number(req.query.id_sede) : null;
    const file = await createPurchasesExport(format, search, req.user.sub, { desde, hasta, idSede });
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


function movementQueryParams(req) {
  return {
    search: String(req.query.search ?? ''),
    desde: req.query.desde ? String(req.query.desde) : null,
    hasta: req.query.hasta ? String(req.query.hasta) : null,
    idSede: req.query.id_sede ? Number(req.query.id_sede) : null
  };
}

reportsRouter.get(
  '/entradas/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createEntradasExport(format, movementQueryParams(req), req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/salidas/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createSalidasExport(format, movementQueryParams(req), req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/rips-am/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createRipsAmExport(format, movementQueryParams(req), req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/pendientes/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createPendientesExport(format, movementQueryParams(req), req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/movimientos-producto/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createProductMovementsExport(format, movementQueryParams(req), req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/maestro/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createMaestroExport(format, movementQueryParams(req), req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/ingresos/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createIngresosExport(format, movementQueryParams(req), req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/devoluciones/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createDevolucionesExport(format, movementQueryParams(req), req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/actas-recepcion/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createActasExport(format, movementQueryParams(req), req.user.sub);
    sendFile(res, file);
  })
);

reportsRouter.get(
  '/dispensing/export',
  authRequired,
  asyncHandler(async (req, res) => {
    const format = String(req.query.format ?? 'json');
    const file = await createDispensingExport(format, movementQueryParams(req), req.user.sub);
    sendFile(res, file);
  })
);
