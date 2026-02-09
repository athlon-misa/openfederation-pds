import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';

/**
 * net.openfederation.community.listMine
 *
 * List all communities the user is a member of (owner, moderator, or member).
 * Uses JOINs to avoid N+1 query patterns.
 */
export default async function listMyCommunities(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) {
    return;
  }

  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

  // Single query with JOINs for profile and member role
  const result = await query<{
    did: string;
    handle: string;
    did_method: string;
    created_at: string;
    profile_display_name: string | null;
    profile_description: string | null;
    member_role: string | null;
  }>(
    `SELECT c.did, c.handle, c.did_method, c.created_at,
            p.record->>'displayName' as profile_display_name,
            p.record->>'description' as profile_description,
            m.record->>'role' as member_role
     FROM communities c
     INNER JOIN members_unique mu ON mu.community_did = c.did AND mu.member_did = $1
     LEFT JOIN records_index p ON p.community_did = c.did
       AND p.collection = 'net.openfederation.community.profile' AND p.rkey = 'self'
     LEFT JOIN records_index m ON m.community_did = c.did
       AND m.collection = 'net.openfederation.community.member' AND m.rkey = mu.record_rkey
     ORDER BY c.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.auth.did, limit, offset]
  );

  const communities = result.rows.map((c) => ({
    did: c.did,
    handle: c.handle,
    didMethod: c.did_method,
    displayName: c.profile_display_name || c.handle,
    description: c.profile_description || '',
    createdAt: c.created_at,
    role: c.member_role || 'member',
  }));

  res.status(200).json({
    communities,
    limit,
    offset,
  });
}
