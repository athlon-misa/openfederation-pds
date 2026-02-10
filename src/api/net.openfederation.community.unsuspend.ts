import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

/**
 * net.openfederation.community.unsuspend
 *
 * PDS admin lifts a community suspension. Restores full functionality.
 */
export default async function unsuspendCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) {
      return;
    }

    const { did } = req.body;

    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: did' });
      return;
    }

    const communityResult = await query<{ did: string; status: string }>(
      'SELECT did, status FROM communities WHERE did = $1',
      [did]
    );

    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    if (communityResult.rows[0].status !== 'suspended') {
      res.status(400).json({
        error: 'NotSuspended',
        message: 'Community is not currently suspended',
      });
      return;
    }

    await query(
      `UPDATE communities
       SET status = 'active', status_changed_at = CURRENT_TIMESTAMP,
           status_changed_by = $1, status_reason = NULL
       WHERE did = $2`,
      [req.auth!.userId, did]
    );

    await auditLog('community.unsuspend', req.auth!.userId, did, {});

    res.status(200).json({ did, status: 'active' });
  } catch (error) {
    console.error('Error unsuspending community:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to unsuspend community' });
  }
}
