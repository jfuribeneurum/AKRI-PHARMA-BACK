import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { getSummary } from '../services/dashboard.service.js';
import { cached } from '../utils/cache.js';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/summary',
  authRequired,
  asyncHandler(async (_req, res) => {
    const data = await cached('dashboard:summary', getSummary, 60_000);
    res.json({ success: true, data });
  })
);
