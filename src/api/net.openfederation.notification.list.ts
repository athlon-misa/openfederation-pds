import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { renderXrpcError } from '../xrpc/errors.js';
import { listNotifications, InvalidCursorError } from '../notification/index.js';
import { parsePagination } from '../xrpc/pagination.js';

const NSID = 'net.openfederation.notification.list';

export default async function listNotificationsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const { limit, cursor } = parsePagination(req.query);
    const category = req.query.category as string | undefined;
    const unreadOnly = req.query.unreadOnly === 'true';
    const result = await listNotifications(req.auth!, { limit, cursor, category, unreadOnly });
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      res.status(400).json({ error: 'InvalidRequest', message: 'cursor is not valid' });
      return;
    }
    renderXrpcError(NSID, res, error);
  }
}
