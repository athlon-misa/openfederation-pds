import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { renderXrpcError, XrpcError } from '../xrpc/errors.js';
import { respondToContactRequest } from '../contact/index.js';

const NSID = 'net.openfederation.contact.respondToRequest';

export default async function respondToRequest(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { rkey, action } = req.body ?? {};

    if (!rkey || !action) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: rkey, action' });
      return;
    }

    await respondToContactRequest(req.auth!, rkey, action).catch(err => {
      if (err.code && err.status) throw new XrpcError(NSID, err.code, err.status, err.message);
      throw err;
    });

    res.status(200).json({ success: true });
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
