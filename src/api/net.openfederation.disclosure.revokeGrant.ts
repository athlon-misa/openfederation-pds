import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import {
  AttestationLifecycleError,
  revokeGrantLifecycle,
} from '../attestation/lifecycle.js';

/**
 * Revoke a viewing grant. Only the attestation subject can revoke.
 */
export default async function revokeGrant(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const result = await revokeGrantLifecycle(req.auth, req.body ?? {}, {
      ipAddress: (req.ip || req.socket?.remoteAddress || '') as string,
    });
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof AttestationLifecycleError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in revokeGrant:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to revoke viewing grant' });
  }
}
