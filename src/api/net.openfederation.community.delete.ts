import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

/**
 * net.openfederation.community.delete
 *
 * Delete a community permanently. Only the community owner or PDS admin can delete.
 * Removes all associated data: records, members, keys, join requests.
 */
export default async function deleteCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { did } = req.body;

    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: did' });
      return;
    }

    // Verify community exists and check ownership
    const communityResult = await query<{ created_by: string; handle: string }>(
      'SELECT created_by, handle FROM communities WHERE did = $1',
      [did]
    );
    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    const isOwner = communityResult.rows[0].created_by === req.auth!.userId;
    const isAdmin = req.auth!.roles.includes('admin');

    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Forbidden', message: 'Only the community owner or PDS admin can delete a community' });
      return;
    }

    // Delete all associated data in the correct order (foreign key constraints)
    // 1. Join requests
    await query('DELETE FROM join_requests WHERE community_did = $1', [did]);

    // 2. Members
    await query('DELETE FROM members_unique WHERE community_did = $1', [did]);

    // 3. Records
    await query('DELETE FROM records_index WHERE community_did = $1', [did]);

    // 4. Repo blocks
    await query('DELETE FROM repo_blocks WHERE community_did = $1', [did]);

    // 5. Commits
    await query('DELETE FROM commits WHERE community_did = $1', [did]);

    // 6. Signing keys
    await query('DELETE FROM signing_keys WHERE community_did = $1', [did]);

    // 7. PLC keys
    await query('DELETE FROM plc_keys WHERE community_did = $1', [did]);

    // 8. Community itself
    await query('DELETE FROM communities WHERE did = $1', [did]);

    await auditLog('community.delete', req.auth!.userId, did, {
      handle: communityResult.rows[0].handle,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting community:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to delete community' });
  }
}
