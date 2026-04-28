import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import {
  AttestationLifecycleError,
  createViewingGrantLifecycle,
} from '../attestation/lifecycle.js';

/**
 * Create a time-limited viewing grant for a private attestation.
 * Only the attestation subject can create grants.
 */
export default async function createViewingGrant(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const auth = req.auth as AuthContext;

    const result = await createViewingGrantLifecycle(auth, req.body ?? {});
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof AttestationLifecycleError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in createViewingGrant:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create viewing grant' });
  }
}
