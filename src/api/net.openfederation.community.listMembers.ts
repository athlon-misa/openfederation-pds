import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { canViewPrivateCommunity, getCommunityAccess } from '../community/visibility.js';

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

    const access = await getCommunityAccess({ communityDid: did, caller: req.auth });
    if (!access.exists) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    if (access.visibility === 'private' && !canViewPrivateCommunity(access)) {
      res.status(403).json({ error: 'Forbidden', message: 'You cannot view members of this private community' });
      return;
    }

    // Fetch members and total count in parallel (independent queries)
    const [membersResult, countResult] = await Promise.all([
      query<{
        rkey: string;
        record: {
          did: string;
          handle: string;
          role?: string;
          roleRkey?: string;
          kind?: string;
          tags?: string[];
          attributes?: Record<string, unknown>;
          joinedAt: string;
        };
      }>(
        `SELECT rkey, record FROM records_index
         WHERE community_did = $1 AND collection = 'net.openfederation.community.member'
         ORDER BY created_at ASC
         LIMIT $2 OFFSET $3`,
        [did, limit, offset]
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM records_index
         WHERE community_did = $1 AND collection = 'net.openfederation.community.member'`,
        [did]
      ),
    ]);

    const members = membersResult.rows.map((row) => {
      const r = row.record;
      // Return a minimal required shape first; attach optional semantic
      // fields only when present so the response stays tight.
      const out: Record<string, unknown> = {
        did: r.did,
        handle: r.handle,
        role: r.role ?? (r.roleRkey ? 'custom' : 'member'),
        joinedAt: r.joinedAt,
      };
      if (r.roleRkey) out.roleRkey = r.roleRkey;
      if (r.kind) out.kind = r.kind;
      if (Array.isArray(r.tags) && r.tags.length > 0) out.tags = r.tags;
      if (r.attributes && typeof r.attributes === 'object' && Object.keys(r.attributes).length > 0) {
        out.attributes = r.attributes;
      }
      return out;
    });

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
