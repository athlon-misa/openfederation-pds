import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { renderXrpcError } from '../xrpc/errors.js';
import { listOutgoingRequests } from '../contact/index.js';
import { parsePagination } from '../xrpc/pagination.js';

const NSID = 'net.openfederation.contact.listOutgoingRequests';

export default async function listOutgoing(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { limit, cursor } = parsePagination(req.query);

    const result = await listOutgoingRequests(req.auth!, limit, cursor);
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
