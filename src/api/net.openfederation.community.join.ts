import { Response } from 'express';
import { randomUUID } from 'crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';

/**
 * net.openfederation.community.join
 *
 * Join a community (open) or request to join (approval policy).
 */
export default async function joinCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) {
      return;
    }

    const auth = req.auth!;
    const { did } = req.body;

    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: did' });
      return;
    }

    // Verify community exists
    const communityResult = await query<{ did: string }>(
      'SELECT did FROM communities WHERE did = $1',
      [did]
    );
    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    // Check if already a member
    const memberCheck = await query(
      'SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [did, auth.did]
    );
    if (memberCheck.rows.length > 0) {
      res.status(409).json({ error: 'AlreadyMember', message: 'You are already a member of this community' });
      return;
    }

    // Get join policy
    const settingsResult = await query<{ record: { joinPolicy?: string } }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [did]
    );
    const joinPolicy = settingsResult.rows[0]?.record?.joinPolicy || 'open';

    if (joinPolicy === 'open') {
      // Direct join
      const engine = new RepoEngine(did);
      const keypair = await getKeypairForDid(did);
      const rkey = RepoEngine.generateTid();
      await engine.putRecord(keypair, 'net.openfederation.community.member', rkey, {
        did: auth.did,
        handle: auth.handle,
        role: 'member',
        joinedAt: new Date().toISOString(),
      });

      res.status(200).json({ status: 'joined' });
    } else {
      // Check for existing request
      const existingRequest = await query<{ status: string }>(
        'SELECT status FROM join_requests WHERE community_did = $1 AND user_id = $2',
        [did, auth.userId]
      );

      if (existingRequest.rows.length > 0) {
        const status = existingRequest.rows[0].status;
        if (status === 'pending') {
          res.status(409).json({ error: 'AlreadyRequested', message: 'You already have a pending join request' });
          return;
        }
        if (status === 'rejected') {
          // Allow re-request by updating existing row
          await query(
            `UPDATE join_requests SET status = 'pending', resolved_by = NULL, resolved_at = NULL, created_at = CURRENT_TIMESTAMP
             WHERE community_did = $1 AND user_id = $2`,
            [did, auth.userId]
          );
          res.status(200).json({ status: 'pending' });
          return;
        }
      }

      // Create join request
      await query(
        `INSERT INTO join_requests (id, community_did, user_id, user_did, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [randomUUID(), did, auth.userId, auth.did]
      );

      res.status(200).json({ status: 'pending' });
    }
  } catch (error) {
    console.error('Error joining community:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to join community' });
  }
}
