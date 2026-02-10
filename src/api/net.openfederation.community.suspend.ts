import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

/**
 * net.openfederation.community.suspend
 *
 * PDS admin suspends a community. This is a reversible moderation action
 * aligned with AT Protocol composable moderation principles.
 *
 * Suspended communities:
 * - Are hidden from public listings
 * - Cannot accept new members or content
 * - Remain visible to the owner (read-only) so they can export
 * - Can be unsuspended by PDS admin
 */
export default async function suspendCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) {
      return;
    }

    const { did, reason } = req.body;

    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: did' });
      return;
    }

    // Fetch community
    const communityResult = await query<{ did: string; status: string }>(
      'SELECT did, status FROM communities WHERE did = $1',
      [did]
    );

    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    const community = communityResult.rows[0];

    if (community.status === 'suspended') {
      res.status(400).json({ error: 'AlreadySuspended', message: 'Community is already suspended' });
      return;
    }

    if (community.status === 'takendown') {
      res.status(400).json({ error: 'AlreadyTakenDown', message: 'Community has already been taken down' });
      return;
    }

    await query(
      `UPDATE communities
       SET status = 'suspended', status_changed_at = CURRENT_TIMESTAMP,
           status_changed_by = $1, status_reason = $2
       WHERE did = $3`,
      [req.auth!.userId, reason || null, did]
    );

    await auditLog('community.suspend', req.auth!.userId, did, { reason: reason || null });

    res.status(200).json({
      did,
      status: 'suspended',
      reason: reason || null,
    });
  } catch (error) {
    console.error('Error suspending community:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to suspend community' });
  }
}
