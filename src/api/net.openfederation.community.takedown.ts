import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { applyTakedown, findTakedownSubject } from '../moderation/takedown.js';

/**
 * net.openfederation.community.takedown
 *
 * Standard takedown of a community (docs/FAIR-USE.md): hidden from everyone at
 * once, the owner is emailed a private export link valid for 30 days, then the
 * data is deleted. For evident illegal content use admin.takedown with
 * tier 'hard'.
 */
export default async function takedownCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) {
      return;
    }

    const { did, reason } = req.body;

    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: did' });
      return;
    }

    const subject = await findTakedownSubject(did);
    if (!subject || subject.kind !== 'community') {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }
    if (subject.status === 'takendown') {
      res.status(400).json({ error: 'AlreadyTakenDown', message: 'Community has already been taken down' });
      return;
    }

    const result = await applyTakedown(subject, {
      tier: 'standard', reason: typeof reason === 'string' && reason.trim() ? reason.trim() : 'Breach of this server\'s rules',
      actorUserId: req.auth!.userId,
    });

    res.status(200).json({
      did,
      status: 'takendown',
      reason: reason || null,
      deleteAfter: result.deleteAfter.toISOString(),
    });
  } catch (error) {
    console.error('Error taking down community:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to take down community' });
  }
}
