import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { getConnectivityOverview } from '../services/status.service.js';

export const statusRouter = Router();

statusRouter.get(
  '/overview',
  authRequired,
  asyncHandler(async (_req, res) => {
    const data = await getConnectivityOverview();
    res.json({ success: true, data });
  })
);
