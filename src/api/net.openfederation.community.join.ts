import { Response } from 'express';
import { randomUUID } from 'crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { findRoleRkeyByName } from '../auth/permissions.js';

const MAX_KIND_LENGTH = 64;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;
const MAX_ATTRIBUTES_SIZE = 4096;

/**
 * net.openfederation.community.join
 *
 * Join a community (open) or request to join (approval policy).
 * Optional semantic fields (kind / tags / attributes) classify the
 * membership — see issue #50. Consuming apps own the vocabulary; the
 * PDS only enforces size bounds so one membership record can't balloon
 * community storage.
 */
export default async function joinCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) {
      return;
    }

    const auth = req.auth!;
    const { did, kind, tags, attributes } = req.body ?? {};

    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: did' });
      return;
    }

    // Size/shape validation on optional semantic fields
    if (kind !== undefined && kind !== null) {
      if (typeof kind !== 'string' || kind.length === 0 || kind.length > MAX_KIND_LENGTH) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `kind must be a non-empty string <= ${MAX_KIND_LENGTH} chars`,
        });
        return;
      }
    }
    if (tags !== undefined && tags !== null) {
      if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `tags must be an array of up to ${MAX_TAGS} strings`,
        });
        return;
      }
      for (const t of tags) {
        if (typeof t !== 'string' || t.length === 0 || t.length > MAX_TAG_LENGTH) {
          res.status(400).json({
            error: 'InvalidRequest',
            message: `each tag must be a non-empty string <= ${MAX_TAG_LENGTH} chars`,
          });
          return;
        }
      }
    }
    if (attributes !== undefined && attributes !== null) {
      if (typeof attributes !== 'object' || Array.isArray(attributes)) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'attributes must be a JSON object',
        });
        return;
      }
      if (JSON.stringify(attributes).length > MAX_ATTRIBUTES_SIZE) {
        res.status(400).json({
          error: 'PayloadTooLarge',
          message: `attributes must not exceed ${MAX_ATTRIBUTES_SIZE} bytes when serialized as JSON`,
        });
        return;
      }
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
      const memberRoleRkey = await findRoleRkeyByName(did, 'member', query);
      const memberRecord: Record<string, unknown> = {
        did: auth.did,
        handle: auth.handle,
        ...(memberRoleRkey ? { roleRkey: memberRoleRkey } : { role: 'member' }),
        joinedAt: new Date().toISOString(),
      };
      if (typeof kind === 'string' && kind.length > 0) memberRecord.kind = kind;
      if (Array.isArray(tags) && tags.length > 0) memberRecord.tags = tags;
      if (attributes && typeof attributes === 'object' && !Array.isArray(attributes) && Object.keys(attributes).length > 0) {
        memberRecord.attributes = attributes;
      }
      await engine.putRecord(keypair, 'net.openfederation.community.member', rkey, memberRecord);

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
