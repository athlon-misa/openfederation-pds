import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { findTakedownSubject, reverseTakedown } from '../moderation/takedown.js';

/**
 * net.openfederation.admin.reverseTakedown
 *
 * Lift a takedown before its deletion date (an appeal upheld, a mistake). The
 * account or community returns to its status before the takedown, and the
 * export links stop working.
 */
export default async function adminReverseTakedown(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;
    const did = req.body?.did;
    if (typeof did !== 'string' || !did.startsWith('did:')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'did is required' });
      return;
    }
    const subject = await findTakedownSubject(did);
    if (!subject) {
      res.status(404).json({ error: 'NotFound', message: 'No account or community with this DID' });
      return;
    }
    if (subject.status !== 'takendown') {
      res.status(400).json({ error: 'NotTakenDown', message: 'This account or community is not taken down' });
      return;
    }
    const status = await reverseTakedown(subject, req.auth!.userId);
    res.status(200).json({ did, kind: subject.kind, status });
  } catch (error) {
    console.error('Error in admin.reverseTakedown:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to reverse the takedown' });
  }
}
