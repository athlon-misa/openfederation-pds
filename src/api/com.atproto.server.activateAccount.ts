import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

/**
 * com.atproto.server.activateAccount
 *
 * ATProto-standard user self-service endpoint. The authenticated user
 * reactivates their own account after self-deactivation.
 *
 * Only works if the account was deactivated by the user themselves
 * (status = 'deactivated'). Admin-suspended or taken-down accounts
 * cannot be reactivated by the user.
 */
export default async function activateAccount(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const userId = req.auth!.userId;
    const userDid = req.auth!.did;

    // Fetch current status
    const userResult = await query<{ status: string }>(
      'SELECT status FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Account not found' });
      return;
    }

    const user = userResult.rows[0];

    if (user.status !== 'deactivated') {
      if (user.status === 'suspended') {
        res.status(403).json({
          error: 'AccountSuspended',
          message: 'Your account has been suspended by an administrator. Contact support.',
        });
        return;
      }
      if (user.status === 'takendown') {
        res.status(410).json({
          error: 'AccountTakenDown',
          message: 'Your account has been taken down.',
        });
        return;
      }
      res.status(400).json({
        error: 'InvalidStatus',
        message: 'Account is not deactivated',
      });
      return;
    }

    // Reactivate
    await query(
      `UPDATE users
       SET status = 'approved', status_changed_at = CURRENT_TIMESTAMP,
           status_changed_by = $1, status_reason = NULL
       WHERE id = $1`,
      [userId]
    );

    await auditLog('account.activate', userId, userId, { did: userDid });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error activating account:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to activate account' });
  }
}
