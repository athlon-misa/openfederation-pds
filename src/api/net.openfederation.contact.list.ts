import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { renderXrpcError } from '../xrpc/errors.js';
import { listContacts } from '../contact/index.js';

const NSID = 'net.openfederation.contact.list';

export default async function list(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 100);
    const cursor = req.query.cursor as string | undefined;

    const result = await listContacts(req.auth!, limit, cursor);
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
