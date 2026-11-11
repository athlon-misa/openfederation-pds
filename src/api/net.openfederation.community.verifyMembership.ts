import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireCommunityReadable } from '../auth/guards.js';
import { query } from '../db/client.js';

/**
 * net.openfederation.community.verifyMembership
 *
 * Check if a DID is a member of a community.
 * Public endpoint — enables external apps (Mastodon, Matrix) to verify
 * that a user belongs to a community before granting access.
 */
export default async function verifyMembership(req: AuthRequest, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;
    const memberDid = req.query.memberDid as string;

    if (!communityDid || !memberDid) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required query parameters: communityDid, memberDid',
      });
      return;
    }

    if (!(await requireCommunityReadable(req, res, communityDid))) return;

    // Check membership via members_unique table
    const memberResult = await query<{ record_rkey: string }>(
      'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [communityDid, memberDid],
    );

    if (memberResult.rows.length === 0) {
      res.status(200).json({ isMember: false });
      return;
    }

    // Load member record for role info
    // A member record names its role either directly (`role`, older records)
    // or by reference to a role record (`roleRkey`, every record written
    // since RBAC). Reading only `role` answered "member" for owners and
    // moderators alike.
    const recordResult = await query<{ role: string | null; role_name: string | null }>(
      `SELECT m.record->>'role' AS role, r.record->>'name' AS role_name
       FROM records_index m
       LEFT JOIN records_index r
         ON r.community_did = m.community_did
        AND r.collection = 'net.openfederation.community.role'
        AND r.rkey = m.record->>'roleRkey'
       WHERE m.community_did = $1 AND m.collection = 'net.openfederation.community.member' AND m.rkey = $2`,
      [communityDid, memberResult.rows[0].record_rkey],
    );

    const role = recordResult.rows[0]?.role_name || recordResult.rows[0]?.role || 'member';

    res.status(200).json({
      isMember: true,
      role,
    });
  } catch (error) {
    console.error('Error verifying membership:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to verify membership' });
  }
}
