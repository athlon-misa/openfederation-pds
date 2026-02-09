import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';

/**
 * net.openfederation.community.listMembers
 *
 * List members of a community. For private communities, only members/owner/admin can see.
 */
export default async function listMembers(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const did = String(req.query.did || '');
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required param: did' });
      return;
    }

    // Check community exists
    const communityResult = await query<{ created_by: string }>(
      'SELECT created_by FROM communities WHERE did = $1',
      [did]
    );
    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    // Check visibility — for private communities, only members/owner/admin
    const settingsResult = await query<{ record: { visibility?: string } }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [did]
    );
    const visibility = settingsResult.rows[0]?.record?.visibility || 'public';
    const isOwner = communityResult.rows[0].created_by === req.auth.userId;
    const isAdmin = req.auth.roles.includes('admin');

    if (visibility === 'private' && !isOwner && !isAdmin) {
      const memberCheck = await query(
        'SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2',
        [did, req.auth.did]
      );
      if (memberCheck.rows.length === 0) {
        res.status(403).json({ error: 'Forbidden', message: 'You cannot view members of this private community' });
        return;
      }
    }

    // Fetch members from records_index
    const membersResult = await query<{
      rkey: string;
      record: { did: string; handle: string; role: string; joinedAt: string };
    }>(
      `SELECT rkey, record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.member'
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [did, limit, offset]
    );

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.member'`,
      [did]
    );

    const members = membersResult.rows.map((row) => ({
      did: row.record.did,
      handle: row.record.handle,
      role: row.record.role,
      joinedAt: row.record.joinedAt,
    }));

    res.status(200).json({
      members,
      total: parseInt(countResult.rows[0].count, 10),
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error listing members:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list members' });
  }
}
