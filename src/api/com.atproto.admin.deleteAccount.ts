import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query, getClient } from '../db/client.js';
import { auditLog } from '../db/audit.js';

/**
 * com.atproto.admin.deleteAccount
 *
 * ATProto-standard admin endpoint to permanently delete a user account.
 * Removes all associated data: signing keys, repo blocks, repo roots,
 * records index, commits, community memberships, sessions, roles, and
 * the user record itself. Uses a transaction to prevent partial deletes.
 */
export default async function adminDeleteAccount(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) {
      return;
    }

    const { did } = req.body;

    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: did' });
      return;
    }

    // Fetch user
    const userResult = await query<{ id: string; did: string; handle: string }>(
      'SELECT id, did, handle FROM users WHERE did = $1',
      [did]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Account not found' });
      return;
    }

    const user = userResult.rows[0];

    // Prevent deletion of admin accounts
    const rolesResult = await query<{ role: string }>(
      'SELECT role FROM user_roles WHERE user_id = $1',
      [user.id]
    );
    const isTargetAdmin = rolesResult.rows.some(r => r.role === 'admin');
    if (isTargetAdmin) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot delete admin accounts' });
      return;
    }

    // Audit log before deletion (so we still have the user record)
    await auditLog('account.delete', req.auth!.userId, user.id, {
      did: user.did,
      handle: user.handle,
    });

    // Delete all associated data in a transaction
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Delete user repo data
      await client.query('DELETE FROM user_signing_keys WHERE user_did = $1', [user.did]);
      await client.query('DELETE FROM records_index WHERE community_did = $1', [user.did]);
      await client.query('DELETE FROM repo_blocks WHERE community_did = $1', [user.did]);
      await client.query('DELETE FROM repo_roots WHERE did = $1', [user.did]);

      // Delete community memberships and join requests
      await client.query('DELETE FROM members_unique WHERE member_did = $1', [user.did]);
      await client.query('DELETE FROM join_requests WHERE user_id = $1', [user.id]);

      // Delete sessions and roles
      await client.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [user.id]);

      // Delete the user record
      await client.query('DELETE FROM users WHERE id = $1', [user.id]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to delete account' });
  }
}
