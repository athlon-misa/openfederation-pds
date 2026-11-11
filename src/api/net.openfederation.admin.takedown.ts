import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { applyTakedown, findTakedownSubject, isTakedownTier } from '../moderation/takedown.js';

/**
 * net.openfederation.admin.takedown
 *
 * Take an account or a community down under the takedown policy
 * (docs/FAIR-USE.md): `standard` gives the owner a private export link and 30
 * days before deletion; `hard` (evident illegal content) gives no owner
 * export and keeps the data 90 days. Calling it again on a subject already
 * taken down changes the tier or the deadline.
 */
export default async function adminTakedown(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;
    const { did, tier, reason, deleteAfter, notify } = req.body ?? {};
    if (typeof did !== 'string' || !did.startsWith('did:') || !isTakedownTier(tier) || typeof reason !== 'string' || !reason.trim()) {
      res.status(400).json({ error: 'InvalidRequest', message: 'did, tier (standard or hard) and reason are required' });
      return;
    }
    let deadline: Date | undefined;
    if (deleteAfter !== undefined) {
      deadline = new Date(String(deleteAfter));
      if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
        res.status(400).json({ error: 'InvalidDeadline', message: 'deleteAfter must be a date in the future' });
        return;
      }
    }
    const subject = await findTakedownSubject(did);
    if (!subject) {
      res.status(404).json({ error: 'NotFound', message: 'No account or community with this DID' });
      return;
    }
    if (subject.isAdminAccount) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot moderate admin accounts' });
      return;
    }
    const result = await applyTakedown(subject, {
      tier, reason: reason.trim(), actorUserId: req.auth!.userId, deleteAfter: deadline, notifyOwner: notify !== false,
    });
    res.status(200).json({
      did: result.did,
      kind: result.kind,
      status: 'takendown',
      tier: result.tier,
      deleteAfter: result.deleteAfter.toISOString(),
      ...(result.exportUrl ? { exportUrl: result.exportUrl } : {}),
    });
  } catch (error) {
    console.error('Error in admin.takedown:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to take down' });
  }
}
