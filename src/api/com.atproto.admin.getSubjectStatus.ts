import { Request, Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';

/**
 * com.atproto.admin.getSubjectStatus
 *
 * ATProto-standard admin endpoint to check the moderation status of an account.
 * Returns takedown and deactivation status for the given DID.
 */
export default async function getSubjectStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) {
      return;
    }

    const did = String(req.query.did || '');
    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required query param: did' });
      return;
    }

    const userResult = await query<{
      id: string;
      did: string;
      handle: string;
      status: string;
      status_reason: string | null;
      status_changed_at: string | null;
      exported_at: string | null;
    }>(
      'SELECT id, did, handle, status, status_reason, status_changed_at, exported_at FROM users WHERE did = $1',
      [did]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Account not found' });
      return;
    }

    const user = userResult.rows[0];

    res.status(200).json({
      subject: { $type: 'com.atproto.admin.defs#repoRef', did: user.did },
      takedown: {
        applied: user.status === 'takendown',
        ref: user.status === 'takendown' ? (user.status_reason || undefined) : undefined,
      },
      deactivated: {
        applied: user.status === 'suspended' || user.status === 'deactivated',
        ref: (user.status === 'suspended' || user.status === 'deactivated') ? (user.status_reason || undefined) : undefined,
      },
    });
  } catch (error) {
    console.error('Error getting subject status:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get subject status' });
  }
}
