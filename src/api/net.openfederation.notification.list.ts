import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { renderXrpcError } from '../xrpc/errors.js';
import { listNotifications } from '../notification/index.js';

const NSID = 'net.openfederation.notification.list';

export default async function listNotificationsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 100);
    const cursor = req.query.cursor as string | undefined;
    const category = req.query.category as string | undefined;
    const unreadOnly = req.query.unreadOnly === 'true';
    const result = await listNotifications(req.auth!, { limit, cursor, category, unreadOnly });
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
