import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import {
  AttestationLifecycleError,
  redeemGrantLifecycle,
} from '../attestation/lifecycle.js';
import type { NetOpenfederationDisclosureRedeemGrantOutput } from '../lexicon/generated.js';

/**
 * Redeem a viewing grant to access a private attestation.
 */
export default async function redeemGrant(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const result: NetOpenfederationDisclosureRedeemGrantOutput = await redeemGrantLifecycle(req.auth, req.body ?? {}, {
      ipAddress: (req.ip || req.socket?.remoteAddress || '') as string,
    });
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof AttestationLifecycleError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in redeemGrant:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to redeem viewing grant' });
  }
}
