import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';

/**
 * net.openfederation.community.removeMember
 *
 * Remove (kick) a member from a community.
 * Only the community owner or PDS admin can remove members.
 * The owner cannot be removed.
 */
export default async function removeMember(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { did, memberDid } = req.body;

    if (!did || !memberDid) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: did, memberDid' });
      return;
    }

    // Verify community exists and check ownership
    const communityResult = await query<{ created_by: string }>(
      'SELECT created_by FROM communities WHERE did = $1',
      [did]
    );
    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    const isOwner = communityResult.rows[0].created_by === req.auth!.userId;
    const isAdmin = req.auth!.roles.includes('admin');

    if (!isOwner && !isAdmin) {
      res.status(403).json({ error: 'Forbidden', message: 'Only the community owner or PDS admin can remove members' });
      return;
    }

    // Prevent removing the owner
    const ownerCheck = await query<{ did: string }>(
      'SELECT u.did FROM users u WHERE u.id = $1',
      [communityResult.rows[0].created_by]
    );
    if (ownerCheck.rows.length > 0 && ownerCheck.rows[0].did === memberDid) {
      res.status(403).json({ error: 'Forbidden', message: 'Cannot remove the community owner' });
      return;
    }

    // Check membership
    const memberResult = await query<{ record_rkey: string }>(
      'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [did, memberDid]
    );
    if (memberResult.rows.length === 0) {
      res.status(400).json({ error: 'NotMember', message: 'User is not a member of this community' });
      return;
    }

    const rkey = memberResult.rows[0].record_rkey;

    // Delete the member record (also removes from members_unique via RepoEngine)
    const engine = new RepoEngine(did);
    const keypair = await getKeypairForDid(did);
    await engine.deleteRecord(keypair, 'net.openfederation.community.member', rkey);

    // Clean up any join requests for the removed user
    const userResult = await query<{ id: string }>(
      'SELECT id FROM users WHERE did = $1',
      [memberDid]
    );
    if (userResult.rows.length > 0) {
      await query(
        'DELETE FROM join_requests WHERE community_did = $1 AND user_id = $2',
        [did, userResult.rows[0].id]
      );
    }

    await auditLog('community.removeMember', req.auth!.userId, did, {
      memberDid,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to remove member' });
  }
}
