import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { env } from './config/env.js';
import { query } from './config/db.js';
import { authRouter } from './routes/auth.routes.js';
import { dashboardRouter } from './routes/dashboard.routes.js';
import { productsRouter } from './routes/products.routes.js';
import { inventoryRouter } from './routes/inventory.routes.js';
import { purchasesRouter } from './routes/purchases.routes.js';
import { salesRouter } from './routes/sales.routes.js';
import { ingresosRouter } from './routes/ingresos.routes.js';
import { coldChainRouter } from './routes/cold-chain.routes.js';
import { billingRouter } from './routes/billing.routes.js';
import { siesaRouter } from './routes/siesa.routes.js';
import { reportsRouter } from './routes/reports.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { dispensingRouter } from './routes/dispensing.routes.js';
import { statusRouter } from './routes/status.routes.js';
import { scannersRouter } from './routes/scanners.routes.js';
import { traceabilityRouter } from './routes/traceability.routes.js';
import { monitoringRouter } from './routes/monitoring.routes.js';
import { signaturesRouter } from './routes/signatures.routes.js';
import { multisiteRouter } from './routes/multisite.routes.js';
import { pacientesRouter } from './routes/pacientes.routes.js';
import { providersRouter } from './routes/providers.routes.js';
import { medicamentosHsRouter } from './routes/medicamentos-hs.routes.js';
import { formulacionHsRouter } from './routes/formulacion-hs.routes.js';
import { dispensacionHsRouter } from './routes/dispensacion-hs.routes.js';
import { ciudadesRouter } from './routes/ciudades.routes.js';
import { trasladosRouter } from './routes/traslados.routes.js';
import { parametrosRouter } from './routes/parametros.routes.js';
import { initParametrosTable } from './services/parametros.service.js';
import { requestTraceMiddleware } from './middleware/request-trace.js';
import { errorHandler } from './middleware/error-handler.js';
import { logger } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const openApiPath = path.join(__dirname, '..', 'docs', 'openapi.yaml');
const swaggerDocument = YAML.load(openApiPath);

fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });

export const app = express();

if (env.TRUST_PROXY) {
  app.set('trust proxy', env.TRUST_PROXY);
}

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
  origin: env.CORS_ORIGIN.length > 0 ? env.CORS_ORIGIN : true,
  credentials: true
}));
app.use(compression());
app.use(express.json({ limit: `${env.MAX_IMAGE_SIZE_MB + 4}mb` }));
app.use(express.urlencoded({ extended: true, limit: `${env.MAX_IMAGE_SIZE_MB + 4}mb` }));
app.use(requestTraceMiddleware);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => req.path === '/healthz' || req.path === '/api/health' || req.path === '/api/ready',
  message: { success: false, message: 'Demasiadas solicitudes, intenta de nuevo en unos minutos.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, message: 'Demasiados intentos de acceso, espera 15 minutos.' }
});

app.use('/api', apiLimiter);
app.use('/api/auth/login', authLimiter);

app.get('/healthz', (_req, res) => {
  res.type('text/plain').send('ok');
});

app.get('/', (_req, res) => {
  res.json({
    success: true,
    name: 'AkriPharmacy API',
    message: 'Servicio operativo',
    docs: '/api/docs',
    ready: '/api/ready',
    health: '/api/health'
  });
});

app.get('/api', (_req, res) => {
  res.json({
    success: true,
    name: 'AkriPharmacy API',
    message: 'Ruta base de la API',
    docs: '/api/docs',
    ready: '/api/ready',
    health: '/api/health',
    auth_login: '/api/auth/login'
  });
});

app.use(pinoHttp({
  logger,
  autoLogging: { ignore: (req) => ['/api/health', '/api/ready', '/healthz'].includes(req.url ?? '') }
}));

app.get('/api/health', (_req, res) => {
  res.json({
    name: 'AkriPharmacy API',
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/ready', async (_req, res) => {
  try {
    await query('SELECT 1 AS ok');
    res.json({
      name: 'AkriPharmacy API',
      status: 'ready',
      db: 'ok',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      name: 'AkriPharmacy API',
      status: 'degraded',
      db: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.use('/api/uploads', express.static(env.UPLOAD_DIR));
app.use('/uploads', express.static(env.UPLOAD_DIR));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use('/api/auth', authRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/products', productsRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/purchases', purchasesRouter);
app.use('/api/sales', salesRouter);
app.use('/api/ingresos', ingresosRouter);
app.use('/api/dispensing', dispensingRouter);
app.use('/api/cold-chain', coldChainRouter);
app.use('/api/billing', billingRouter);
app.use('/api/siesa', siesaRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/status', statusRouter);
app.use('/api/scanners', scannersRouter);
app.use('/api/traceability', traceabilityRouter);
app.use('/api/signatures', signaturesRouter);
app.use('/api/multisite', multisiteRouter);
app.use('/api/pacientes', pacientesRouter);
app.use('/api/providers', providersRouter);
app.use('/api/medicamentos-hs', medicamentosHsRouter);
app.use('/api/formulaciones-hs', formulacionHsRouter);
app.use('/api/dispensacion-hs', dispensacionHsRouter);
app.use('/api/ciudades', ciudadesRouter);
app.use('/api/traslados', trasladosRouter);
app.use('/api/parametros', parametrosRouter);
app.use('/', monitoringRouter);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada'
  });
});

app.use(errorHandler);
