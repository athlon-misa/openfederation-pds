import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { getCommunityAccess } from '../community/visibility.js';

/**
 * net.openfederation.community.listJoinRequests
 *
 * List pending join requests for a community. Owner or admin only.
 * Uses JOIN to fetch user handles in a single query.
 */
export default async function listJoinRequests(req: AuthRequest, res: Response): Promise<void> {
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

    const access = await getCommunityAccess({ communityDid: did, caller: req.auth });
    if (!access.exists) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    if (!access.isOwner && !access.isAdmin) {
      res.status(403).json({ error: 'Forbidden', message: 'Only the community owner or admin can view join requests' });
      return;
    }

    // Single query joining join_requests with users to get handles
    const requestsResult = await query<{
      id: string;
      user_id: string;
      user_did: string;
      status: string;
      created_at: string;
      handle: string;
    }>(
      `SELECT jr.id, jr.user_id, jr.user_did, jr.status, jr.created_at,
              COALESCE(u.handle, 'unknown') as handle
       FROM join_requests jr
       LEFT JOIN users u ON u.id = jr.user_id
       WHERE jr.community_did = $1 AND jr.status = 'pending'
       ORDER BY jr.created_at ASC
       LIMIT $2 OFFSET $3`,
      [did, limit, offset]
    );

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM join_requests WHERE community_did = $1 AND status = 'pending'`,
      [did]
    );

    const requests = requestsResult.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userDid: r.user_did,
      handle: r.handle,
      status: r.status,
      createdAt: r.created_at,
    }));

    res.status(200).json({
      requests,
      total: parseInt(countResult.rows[0].count, 10),
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error listing join requests:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list join requests' });
  }
}
