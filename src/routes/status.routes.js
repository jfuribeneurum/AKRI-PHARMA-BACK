import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { getConnectivityOverview } from '../services/status.service.js';
import { cached } from '../utils/cache.js';

export const statusRouter = Router();

statusRouter.get(
  '/overview',
  authRequired,
  asyncHandler(async (_req, res) => {
    const data = await cached('status:overview', getConnectivityOverview, 30_000);
    res.json({ success: true, data });
  })
);
