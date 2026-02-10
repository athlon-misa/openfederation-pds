import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';

/**
 * net.openfederation.community.get
 *
 * Get community detail + caller's membership status.
 * Auth is optional — unauthenticated callers see public communities without membership info.
 */
export default async function getCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    const did = String(req.query.did || '');
    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required param: did' });
      return;
    }

    // Fetch community
    const communityResult = await query<{
      did: string;
      handle: string;
      did_method: string;
      created_by: string;
      created_at: string;
      status: string;
      status_reason: string | null;
    }>(
      'SELECT did, handle, did_method, created_by, created_at, status, status_reason FROM communities WHERE did = $1',
      [did]
    );

    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    const community = communityResult.rows[0];

    // Taken-down communities are invisible to everyone except PDS admin
    if (community.status === 'takendown') {
      const isAdmin = req.auth?.roles?.includes('admin') || false;
      if (!isAdmin) {
        res.status(410).json({ error: 'CommunityTakenDown', message: 'This community has been taken down.' });
        return;
      }
    }

    // Fetch profile
    const profileResult = await query<{ record: { displayName?: string; description?: string } }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.profile' AND rkey = 'self'`,
      [did]
    );
    const profile = profileResult.rows[0]?.record;

    // Fetch settings
    const settingsResult = await query<{ record: { visibility?: string; joinPolicy?: string; didMethod?: string } }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [did]
    );
    const settings = settingsResult.rows[0]?.record;
    const visibility = settings?.visibility || 'public';
    const joinPolicy = settings?.joinPolicy || 'open';

    // Member count
    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM members_unique WHERE community_did = $1',
      [did]
    );
    const memberCount = parseInt(countResult.rows[0].count, 10);

    // Caller-specific info
    const userId = req.auth?.userId;
    const isOwner = userId ? community.created_by === userId : false;
    const isAdmin = req.auth?.roles?.includes('admin') || false;

    // Private community: only visible to members, owner, or admin
    if (visibility === 'private' && !isOwner && !isAdmin) {
      if (!userId) {
        res.status(404).json({ error: 'NotFound', message: 'Community not found' });
        return;
      }
      const memberCheck = await query(
        'SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2',
        [did, req.auth!.did]
      );
      if (memberCheck.rows.length === 0) {
        res.status(404).json({ error: 'NotFound', message: 'Community not found' });
        return;
      }
    }

    let isMember = false;
    let joinRequestStatus: string | null = null;

    if (userId) {
      const memberResult = await query(
        'SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2',
        [did, req.auth!.did]
      );
      isMember = memberResult.rows.length > 0;

      if (!isMember) {
        const requestResult = await query<{ status: string }>(
          'SELECT status FROM join_requests WHERE community_did = $1 AND user_id = $2',
          [did, userId]
        );
        joinRequestStatus = requestResult.rows[0]?.status || null;
      }
    }

    res.status(200).json({
      did: community.did,
      handle: community.handle,
      didMethod: community.did_method,
      displayName: profile?.displayName || community.handle,
      description: profile?.description || '',
      visibility,
      joinPolicy,
      memberCount,
      createdAt: community.created_at,
      status: community.status,
      statusReason: community.status_reason,
      isOwner,
      isMember,
      joinRequestStatus,
    });
  } catch (error) {
    console.error('Error getting community:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get community' });
  }
}
