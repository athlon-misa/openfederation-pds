import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { assertAuth } from '../auth/guards.js';
import { renderXrpcError } from '../xrpc/errors.js';
import { listContacts } from '../contact/index.js';
import { parsePagination } from '../xrpc/pagination.js';

const NSID = 'net.openfederation.contact.list';

export default async function list(req: AuthRequest, res: Response): Promise<void> {
  try {
    assertAuth(req);

    const { limit, cursor } = parsePagination(req.query);

    const result = await listContacts(req.auth, limit, cursor);
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
