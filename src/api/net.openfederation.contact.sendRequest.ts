import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { renderXrpcError, XrpcError } from '../xrpc/errors.js';
import { sendContactRequest } from '../contact/index.js';

const NSID = 'net.openfederation.contact.sendRequest';

export default async function sendRequest(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { subject, note } = req.body ?? {};

    if (!subject) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: subject' });
      return;
    }

    const result = await sendContactRequest(req.auth!, subject, note).catch(err => {
      if (err.code && err.status) throw new XrpcError(NSID, err.code, err.status, err.message);
      throw err;
    });

    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
