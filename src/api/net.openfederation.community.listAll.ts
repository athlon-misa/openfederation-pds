import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';

/**
 * net.openfederation.community.listAll
 *
 * List public communities (explore) excluding ones the user already joined.
 * Admin can pass mode=all to see all communities (for admin oversight).
 * Uses JOINs to avoid N+1 query patterns.
 */
export default async function listAllCommunities(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
    const mode = String(req.query.mode || 'public');

    const isAdmin = req.auth.roles.includes('admin');
    const showAll = mode === 'all' && isAdmin;

    let countQuery: string;
    let countParams: any[];
    let dataQuery: string;
    let dataParams: any[];

    if (showAll) {
      // Admin sees all communities including suspended/takendown
      countQuery = 'SELECT COUNT(*) as count FROM communities';
      countParams = [];
      dataQuery = `
        SELECT c.did, c.handle, c.did_method, c.created_at, c.status as community_status,
               s.record as settings, p.record as profile,
               COALESCE(mc.member_count, 0) as member_count,
               CASE WHEN mu.member_did IS NOT NULL THEN true ELSE false END as is_member,
               jr.status as join_request_status
        FROM communities c
        LEFT JOIN records_index s ON s.community_did = c.did
          AND s.collection = 'net.openfederation.community.settings' AND s.rkey = 'self'
        LEFT JOIN records_index p ON p.community_did = c.did
          AND p.collection = 'net.openfederation.community.profile' AND p.rkey = 'self'
        LEFT JOIN (
          SELECT community_did, COUNT(*)::int as member_count
          FROM members_unique GROUP BY community_did
        ) mc ON mc.community_did = c.did
        LEFT JOIN members_unique mu ON mu.community_did = c.did AND mu.member_did = $3
        LEFT JOIN join_requests jr ON jr.community_did = c.did AND jr.user_id = $4
          AND jr.status = 'pending'
        ORDER BY c.created_at DESC
        LIMIT $1 OFFSET $2`;
      dataParams = [limit, offset, req.auth.did, req.auth.userId];
    } else {
      // Public view: only active, public communities that user hasn't joined
      countQuery = `
        SELECT COUNT(*) as count FROM communities c
        LEFT JOIN records_index s ON s.community_did = c.did
          AND s.collection = 'net.openfederation.community.settings' AND s.rkey = 'self'
        WHERE c.status = 'active'
          AND COALESCE(s.record->>'visibility', 'public') = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM members_unique mu
            WHERE mu.community_did = c.did AND mu.member_did = $1
          )`;
      countParams = [req.auth.did];
      dataQuery = `
        SELECT c.did, c.handle, c.did_method, c.created_at, c.status as community_status,
               s.record as settings, p.record as profile,
               COALESCE(mc.member_count, 0) as member_count,
               false as is_member,
               jr.status as join_request_status
        FROM communities c
        LEFT JOIN records_index s ON s.community_did = c.did
          AND s.collection = 'net.openfederation.community.settings' AND s.rkey = 'self'
        LEFT JOIN records_index p ON p.community_did = c.did
          AND p.collection = 'net.openfederation.community.profile' AND p.rkey = 'self'
        LEFT JOIN (
          SELECT community_did, COUNT(*)::int as member_count
          FROM members_unique GROUP BY community_did
        ) mc ON mc.community_did = c.did
        LEFT JOIN join_requests jr ON jr.community_did = c.did AND jr.user_id = $4
          AND jr.status = 'pending'
        WHERE c.status = 'active'
          AND COALESCE(s.record->>'visibility', 'public') = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM members_unique mu2
            WHERE mu2.community_did = c.did AND mu2.member_did = $3
          )
        ORDER BY c.created_at DESC
        LIMIT $1 OFFSET $2`;
      dataParams = [limit, offset, req.auth.did, req.auth.userId];
    }

    const [countResult, dataResult] = await Promise.all([
      query<{ count: string }>(countQuery, countParams),
      query<{
        did: string;
        handle: string;
        did_method: string;
        created_at: string;
        settings: { visibility?: string; joinPolicy?: string } | null;
        profile: { displayName?: string; description?: string } | null;
        member_count: number;
        is_member: boolean;
        join_request_status: string | null;
      }>(dataQuery, dataParams),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    const communities = dataResult.rows.map((c: any) => ({
      did: c.did,
      handle: c.handle,
      didMethod: c.did_method,
      displayName: c.profile?.displayName || c.handle,
      description: c.profile?.description || '',
      visibility: c.settings?.visibility || 'public',
      joinPolicy: c.settings?.joinPolicy || 'open',
      memberCount: c.member_count,
      createdAt: c.created_at,
      status: c.community_status || 'active',
      isMember: c.is_member,
      joinRequestStatus: c.join_request_status || null,
    }));

    res.status(200).json({ communities, total, limit, offset });
  } catch (error) {
    console.error('Error listing communities:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list communities' });
  }
}
