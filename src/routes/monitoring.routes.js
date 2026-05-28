import { Router } from 'express';
import { env } from '../config/env.js';
import { renderPrometheusMetrics } from '../services/metrics.service.js';

export const monitoringRouter = Router();

function authorized(req) {
  if (!env.METRICS_TOKEN) return true;
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const headerToken = req.headers['x-metrics-token'];
  return bearer === env.METRICS_TOKEN || headerToken === env.METRICS_TOKEN;
}

monitoringRouter.get('/metrics', (req, res) => {
  if (!env.METRICS_ENABLED) {
    return res.status(404).type('text/plain').send('metrics disabled');
  }
  if (!authorized(req)) {
    return res.status(401).json({ success: false, message: 'Token de métricas inválido' });
  }
  res.type('text/plain; version=0.0.4; charset=utf-8').send(renderPrometheusMetrics());
});
