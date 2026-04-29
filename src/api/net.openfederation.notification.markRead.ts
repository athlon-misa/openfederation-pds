import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { renderXrpcError } from '../xrpc/errors.js';
import { markNotificationsRead } from '../notification/index.js';

const NSID = 'net.openfederation.notification.markRead';

export default async function markReadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const { ids } = req.body ?? {};
    if (ids === undefined) { res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: ids' }); return; }
    if (ids !== 'all' && !Array.isArray(ids)) { res.status(400).json({ error: 'InvalidRequest', message: 'ids must be an array of UUIDs or the string "all"' }); return; }
    const marked = await markNotificationsRead(req.auth!, ids);
    res.status(200).json({ marked });
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
