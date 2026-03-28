import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, MEMBER_COLLECTION } from '../auth/permissions.js';

export default async function deleteRole(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, rkey } = req.body;

    if (!communityDid || !rkey) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: communityDid, rkey' });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.role.write'
    );
    if (!hasPermission) return;

    const existing = await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, ROLE_COLLECTION, rkey]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'RoleNotFound', message: 'No role found with the given rkey' });
      return;
    }

    const membersWithRole = await query(
      `SELECT 1 FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'roleRkey' = $3
       LIMIT 1`,
      [communityDid, MEMBER_COLLECTION, rkey]
    );
    if (membersWithRole.rows.length > 0) {
      res.status(409).json({
        error: 'RoleInUse',
        message: 'Cannot delete a role that has members assigned. Reassign members first.',
      });
      return;
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);
    await engine.deleteRecord(keypair, ROLE_COLLECTION, rkey);

    await auditLog('community.role.delete', req.auth!.userId, communityDid, {
      rkey, roleName: existing.rows[0].record?.name,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in deleteRole:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to delete role' });
  }
}
