import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { canViewPrivateCommunity, getCommunityAccess } from '../community/visibility.js';

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

    // Single-table read from projection — no records_index join needed
    const [membersResult, countResult] = await Promise.all([
      query<{
        member_did: string;
        handle: string;
        display_name: string | null;
        avatar_url: string | null;
        role: string | null;
        role_rkey: string | null;
        kind: string | null;
        tags: string[] | null;
        attributes: Record<string, unknown> | null;
        created_at: string;
        record_rkey: string;
      }>(
        `SELECT member_did, handle, display_name, avatar_url, role, role_rkey,
                kind, tags, attributes, created_at, record_rkey
         FROM members_unique
         WHERE community_did = $1
         ORDER BY created_at ASC
         LIMIT $2 OFFSET $3`,
        [did, limit, offset],
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM members_unique WHERE community_did = $1`,
        [did],
      ),
    ]);

    // For joinedAt we still need the record — but we have record_rkey, so we
    // can look it up from records_index in one batch query (not N+1).
    const rkeys = membersResult.rows.map(r => r.record_rkey);
    let joinedAtMap: Record<string, string> = {};
    if (rkeys.length > 0) {
      const joinedResult = await query<{ rkey: string; joined_at: string }>(
        `SELECT rkey, record->>'joinedAt' as joined_at
         FROM records_index
         WHERE community_did = $1
           AND collection = 'net.openfederation.community.member'
           AND rkey = ANY($2)`,
        [did, rkeys],
      );
      for (const row of joinedResult.rows) {
        joinedAtMap[row.rkey] = row.joined_at;
      }
    }

    const members = membersResult.rows.map((row) => {
      const out: Record<string, unknown> = {
        did: row.member_did,
        handle: row.handle,
        displayName: row.display_name ?? row.handle,
        avatarUrl: row.avatar_url ?? null,
        role: row.role ?? (row.role_rkey ? 'custom' : 'member'),
        joinedAt: joinedAtMap[row.record_rkey] ?? new Date(row.created_at).toISOString(),
      };
      if (row.role_rkey) out.roleRkey = row.role_rkey;
      if (row.kind) out.kind = row.kind;
      if (Array.isArray(row.tags) && row.tags.length > 0) out.tags = row.tags;
      if (row.attributes && typeof row.attributes === 'object' && Object.keys(row.attributes).length > 0) {
        out.attributes = row.attributes;
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
