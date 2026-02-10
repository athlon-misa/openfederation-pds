import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

/**
 * net.openfederation.community.takedown
 *
 * PDS admin takes down a community. This is a severe moderation action
 * aligned with AT Protocol's composable moderation. Unlike deletion,
 * takedown preserves the DID and records but makes the community
 * inaccessible to all users.
 *
 * IMPORTANT: Requires that the community has been exported at least once
 * before takedown. This enforces the AT Protocol "free to go" principle —
 * the owner must have had the opportunity to export their data.
 *
 * The community should be suspended first (giving the owner time to export)
 * before a takedown is issued.
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

    const communityResult = await query<{
      did: string;
      status: string;
      exported_at: string | null;
    }>(
      'SELECT did, status, exported_at FROM communities WHERE did = $1',
      [did]
    );

    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    const community = communityResult.rows[0];

    if (community.status === 'takendown') {
      res.status(400).json({ error: 'AlreadyTakenDown', message: 'Community has already been taken down' });
      return;
    }

    // Enforce mandatory export-before-takedown
    if (!community.exported_at) {
      res.status(409).json({
        error: 'ExportRequired',
        message: 'Community must be exported before takedown. The owner must have the opportunity to export their data (AT Protocol "free to go" principle). Suspend the community first, then ensure an export has been performed.',
      });
      return;
    }

    await query(
      `UPDATE communities
       SET status = 'takendown', status_changed_at = CURRENT_TIMESTAMP,
           status_changed_by = $1, status_reason = $2
       WHERE did = $3`,
      [req.auth!.userId, reason || null, did]
    );

    await auditLog('community.takedown', req.auth!.userId, did, {
      reason: reason || null,
      previousStatus: community.status,
      exportedAt: community.exported_at,
    });

    res.status(200).json({
      did,
      status: 'takendown',
      reason: reason || null,
    });
  } catch (error) {
    console.error('Error taking down community:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to take down community' });
  }
}
