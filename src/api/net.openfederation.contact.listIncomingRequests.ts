import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { renderXrpcError } from '../xrpc/errors.js';
import { listIncomingRequests } from '../contact/index.js';
import { parsePagination } from '../xrpc/pagination.js';

const NSID = 'net.openfederation.contact.listIncomingRequests';

export default async function listIncoming(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { limit, cursor } = parsePagination(req.query);

    const result = await listIncomingRequests(req.auth!, limit, cursor);
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
