import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { listConsents } from '../wallet/index.js';

/**
 * GET net.openfederation.wallet.listConsents
 *
 * Returns the authenticated user's active (unrevoked, unexpired) Tier 1
 * signing consents, newest first.
 */
export default async function walletListConsents(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) return;
    const grants = await listConsents(req.auth!.did);
    res.status(200).json({ consents: grants });
  } catch (err) {
    console.error('Error in walletListConsents:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to list consents' });
    }
  }
}
