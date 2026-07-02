import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { renderXrpcError } from '../xrpc/errors.js';
import { listBlocks } from '../contact/index.js';
import { parsePagination } from '../xrpc/pagination.js';

const NSID = 'net.openfederation.contact.listBlocks';

export default async function listBlocksHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const { limit, cursor } = parsePagination(req.query);
    const result = await listBlocks(req.auth!, limit, cursor);
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
