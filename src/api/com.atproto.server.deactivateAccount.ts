import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

/**
 * com.atproto.server.deactivateAccount
 *
 * ATProto-standard user self-service endpoint. The authenticated user
 * deactivates their own account. Sets status to 'deactivated' and
 * revokes all active sessions. No admin action required.
 *
 * The user can reactivate later via com.atproto.server.activateAccount.
 */
export default async function deactivateAccount(req: AuthRequest, res: Response): Promise<void> {
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

    if (user.status === 'deactivated') {
      res.status(400).json({ error: 'AlreadyDeactivated', message: 'Account is already deactivated' });
      return;
    }

    if (user.status !== 'approved') {
      res.status(400).json({
        error: 'InvalidStatus',
        message: 'Only approved accounts can be deactivated',
      });
      return;
    }

    // Set status to deactivated
    await query(
      `UPDATE users
       SET status = 'deactivated', status_changed_at = CURRENT_TIMESTAMP,
           status_changed_by = $1, status_reason = 'User-initiated deactivation'
       WHERE id = $1`,
      [userId]
    );

    // Revoke all sessions
    await query(
      'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );

    await auditLog('account.deactivate', userId, userId, { did: userDid });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deactivating account:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to deactivate account' });
  }
}
