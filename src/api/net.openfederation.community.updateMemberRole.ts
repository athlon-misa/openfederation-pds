import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityRole } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

const MEMBER_COLLECTION = 'net.openfederation.community.member';
const VALID_ROLES = ['moderator', 'member'];

export default async function updateMemberRole(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, memberDid, role } = req.body;

    if (!communityDid || !memberDid || !role) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, memberDid, role',
      });
      return;
    }

    if (!VALID_ROLES.includes(role)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'role must be "moderator" or "member". Cannot set to "owner".',
      });
      return;
    }

    const callerRole = await requireCommunityRole(
      req as AuthRequest & { auth: AuthContext },
      res, communityDid, ['owner']
    );
    if (callerRole === null) return;

    const memberResult = await query<{ record_rkey: string }>(
      'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [communityDid, memberDid]
    );

    if (memberResult.rows.length === 0) {
      res.status(404).json({
        error: 'NotMember',
        message: 'Target DID is not a member of this community',
      });
      return;
    }

    const rkey = memberResult.rows[0].record_rkey;
    const engine = new RepoEngine(communityDid);
    const existing = await engine.getRecord(MEMBER_COLLECTION, rkey);

    if (!existing) {
      res.status(404).json({
        error: 'NotMember',
        message: 'Member record not found in repository',
      });
      return;
    }

    if (existing.record?.role === 'owner') {
      res.status(400).json({
        error: 'CannotChangeOwner',
        message: 'Cannot change the owner\'s role. Use the transfer endpoint instead.',
      });
      return;
    }

    const keypair = await getKeypairForDid(communityDid);
    const updatedRecord = { ...existing.record, role };
    const result = await engine.putRecord(keypair, MEMBER_COLLECTION, rkey, updatedRecord);

    await auditLog('community.updateMemberRole', req.auth!.userId, communityDid, {
      memberDid,
      previousRole: existing.record?.role,
      newRole: role,
    });

    res.status(200).json({ uri: result.uri, cid: result.cid, role });
  } catch (error) {
    console.error('Error in updateMemberRole:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to update member role',
    });
  }
}
