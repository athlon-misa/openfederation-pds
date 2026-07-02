import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { assertAuth } from '../auth/guards.js';
import { renderXrpcError, XrpcError } from '../xrpc/errors.js';
import { listMutualContacts } from '../contact/index.js';
import { parsePagination } from '../xrpc/pagination.js';

const NSID = 'net.openfederation.contact.listMutualContacts';

export default async function listMutualContactsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    assertAuth(req);
    const subject = String(req.query.subject || '');
    if (!subject) { res.status(400).json({ error: 'InvalidRequest', message: 'Missing required param: subject' }); return; }
    const { limit, cursor } = parsePagination(req.query);
    const result = await listMutualContacts(req.auth, subject, limit, cursor).catch(err => {
      if (err.code && err.status) throw new XrpcError(NSID, err.code, err.status, err.message);
      throw err;
    });
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
