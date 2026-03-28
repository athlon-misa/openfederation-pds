import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, MEMBER_COLLECTION } from '../auth/permissions.js';

export default async function updateMemberRole(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, memberDid, roleRkey } = req.body;

    if (!communityDid || !memberDid || !roleRkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, memberDid, roleRkey',
      });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext },
      res, communityDid, 'community.member.write'
    );
    if (!hasPermission) return;

    // Verify target role exists
    const roleResult = await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, ROLE_COLLECTION, roleRkey]
    );
    if (roleResult.rows.length === 0) {
      res.status(404).json({ error: 'RoleNotFound', message: 'Target role not found' });
      return;
    }

    const targetRoleName = roleResult.rows[0].record?.name;

    // Find the member's record rkey
    const memberResult = await query<{ record_rkey: string }>(
      'SELECT record_rkey FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [communityDid, memberDid]
    );
    if (memberResult.rows.length === 0) {
      res.status(404).json({ error: 'NotMember', message: 'Target DID is not a member of this community' });
      return;
    }

    const memberRkey = memberResult.rows[0].record_rkey;
    const engine = new RepoEngine(communityDid);
    const existing = await engine.getRecord(MEMBER_COLLECTION, memberRkey);
    if (!existing) {
      res.status(404).json({ error: 'NotMember', message: 'Member record not found in repository' });
      return;
    }

    const keypair = await getKeypairForDid(communityDid);
    const updatedRecord = { ...existing.record, roleRkey };
    // Remove old role string if present
    delete (updatedRecord as any).role;

    const result = await engine.putRecord(keypair, MEMBER_COLLECTION, memberRkey, updatedRecord);

    await auditLog('community.updateMemberRole', req.auth!.userId, communityDid, {
      memberDid, roleRkey, roleName: targetRoleName,
    });

    res.status(200).json({ uri: result.uri, cid: result.cid, role: targetRoleName, roleRkey });
  } catch (error) {
    console.error('Error in updateMemberRole:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to update member role' });
  }
}
