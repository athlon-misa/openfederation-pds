import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { SimpleRepoEngine } from '../repo/simple-engine.js';

/**
 * net.openfederation.community.leave
 *
 * Leave a community. Owner cannot leave.
 */
export default async function leaveCommunity(req: AuthRequest, res: Response): Promise<void> {
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
    const communityResult = await query<{ created_by: string }>(
      'SELECT created_by FROM communities WHERE did = $1',
      [did]
    );
    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    if (communityResult.rows[0].created_by === req.auth.userId) {
      res.status(403).json({ error: 'Forbidden', message: 'The community owner cannot leave the community' });
      return;
    }

    // Check membership
    const memberResult = await query<{ record_rkey: string }>(
      'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [did, req.auth.did]
    );
    if (memberResult.rows.length === 0) {
      res.status(400).json({ error: 'NotMember', message: 'You are not a member of this community' });
      return;
    }

    const rkey = memberResult.rows[0].record_rkey;

    // Delete the member record
    const engine = new SimpleRepoEngine(did);
    await engine.deleteRecord('', 'net.openfederation.community.member', rkey);

    // Delete from members_unique
    await query(
      'DELETE FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [did, req.auth.did]
    );

    // Clean up any join requests
    await query(
      'DELETE FROM join_requests WHERE community_did = $1 AND user_id = $2',
      [did, req.auth.userId]
    );

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error leaving community:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to leave community' });
  }
}
