import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

/**
 * com.atproto.admin.updateSubjectStatus
 *
 * ATProto-standard admin moderation endpoint. Allows PDS admins to
 * suspend/unsuspend or takedown/reverse-takedown a user account by DID.
 *
 * Suspend = admin-initiated deactivation (reversible)
 * Takedown = severe moderation action (requires prior export per AT Protocol "free to go" principle)
 *
 * All active sessions are revoked on suspend and takedown.
 */
export default async function updateSubjectStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin', 'moderator'])) {
      return;
    }

    const { subject, takedown, deactivated } = req.body;

    // Takedown/reverse-takedown is admin-only (irreversible moderation action)
    if (takedown !== undefined && !req.auth!.roles.includes('admin')) {
      res.status(403).json({ error: 'Forbidden', message: 'Only admins can perform takedown actions' });
      return;
    }

    if (!subject?.did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: subject.did' });
      return;
    }

    const did: string = subject.did;

    // Fetch user
    const userResult = await query<{
      id: string;
      did: string;
      handle: string;
      status: string;
      exported_at: string | null;
    }>(
      'SELECT id, did, handle, status, exported_at FROM users WHERE did = $1',
      [did]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Account not found' });
      return;
    }

    const user = userResult.rows[0];

    // Prevent moderation of admin accounts
    const rolesResult = await query<{ role: string }>(
      'SELECT role FROM user_roles WHERE user_id = $1',
      [user.id]
    );
    const isTargetAdmin = rolesResult.rows.some(r => r.role === 'admin');
    if (isTargetAdmin) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot moderate admin accounts' });
      return;
    }

    // Handle takedown
    if (takedown !== undefined) {
      if (takedown.applied) {
        // Apply takedown
        if (user.status === 'takendown') {
          res.status(400).json({ error: 'AlreadyTakenDown', message: 'Account has already been taken down' });
          return;
        }

        if (!user.exported_at) {
          res.status(409).json({
            error: 'ExportRequired',
            message: 'Account must be exported before takedown. The user must have the opportunity to export their data (AT Protocol "free to go" principle).',
          });
          return;
        }

        await query(
          `UPDATE users
           SET status = 'takendown', status_changed_at = CURRENT_TIMESTAMP,
               status_changed_by = $1, status_reason = $2
           WHERE id = $3`,
          [req.auth!.userId, takedown.ref || null, user.id]
        );

        // Revoke all sessions
        await query(
          'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL',
          [user.id]
        );

        await auditLog('account.takedown', req.auth!.userId, user.id, {
          did,
          reason: takedown.ref || null,
          previousStatus: user.status,
        });
      } else {
        // Reverse takedown
        if (user.status !== 'takendown') {
          res.status(400).json({ error: 'NotTakenDown', message: 'Account is not taken down' });
          return;
        }

        await query(
          `UPDATE users
           SET status = 'approved', status_changed_at = CURRENT_TIMESTAMP,
               status_changed_by = $1, status_reason = NULL
           WHERE id = $2`,
          [req.auth!.userId, user.id]
        );

        await auditLog('account.unsuspend', req.auth!.userId, user.id, {
          did,
          previousStatus: 'takendown',
        });
      }
    }

    // Handle deactivated (admin-initiated suspend/unsuspend)
    if (deactivated !== undefined) {
      if (deactivated.applied) {
        // Suspend
        if (user.status === 'suspended') {
          res.status(400).json({ error: 'AlreadySuspended', message: 'Account is already suspended' });
          return;
        }

        if (user.status === 'takendown') {
          res.status(400).json({ error: 'AlreadyTakenDown', message: 'Account has already been taken down' });
          return;
        }

        await query(
          `UPDATE users
           SET status = 'suspended', status_changed_at = CURRENT_TIMESTAMP,
               status_changed_by = $1, status_reason = $2
           WHERE id = $3`,
          [req.auth!.userId, deactivated.ref || null, user.id]
        );

        // Revoke all sessions
        await query(
          'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL',
          [user.id]
        );

        await auditLog('account.suspend', req.auth!.userId, user.id, {
          did,
          reason: deactivated.ref || null,
          previousStatus: user.status,
        });
      } else {
        // Unsuspend
        if (user.status !== 'suspended') {
          res.status(400).json({ error: 'NotSuspended', message: 'Account is not suspended' });
          return;
        }

        await query(
          `UPDATE users
           SET status = 'approved', status_changed_at = CURRENT_TIMESTAMP,
               status_changed_by = $1, status_reason = NULL
           WHERE id = $2`,
          [req.auth!.userId, user.id]
        );

        await auditLog('account.unsuspend', req.auth!.userId, user.id, {
          did,
          previousStatus: 'suspended',
        });
      }
    }

    // Re-fetch updated status
    const updated = await query<{ status: string; exported_at: string | null }>(
      'SELECT status, exported_at FROM users WHERE id = $1',
      [user.id]
    );

    const currentStatus = updated.rows[0]?.status || user.status;

    res.status(200).json({
      subject: { $type: 'com.atproto.admin.defs#repoRef', did },
      takedown: { applied: currentStatus === 'takendown' },
      deactivated: { applied: currentStatus === 'suspended' || currentStatus === 'deactivated' },
    });
  } catch (error) {
    console.error('Error updating subject status:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to update subject status' });
  }
}
