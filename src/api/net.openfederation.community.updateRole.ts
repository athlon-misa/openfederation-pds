import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, ALL_PERMISSIONS, OWNER_REQUIRED_PERMISSIONS } from '../auth/permissions.js';

export default async function updateRole(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, rkey, name, description, permissions } = req.body;

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

    const currentRole = existing.rows[0].record;

    if (permissions) {
      if (!Array.isArray(permissions)) {
        res.status(400).json({ error: 'InvalidRequest', message: 'permissions must be an array' });
        return;
      }
      const invalid = permissions.filter((p: string) => !ALL_PERMISSIONS.includes(p as any));
      if (invalid.length > 0) {
        res.status(400).json({ error: 'InvalidRequest', message: `Invalid permissions: ${invalid.join(', ')}` });
        return;
      }

      if (currentRole.name === 'owner') {
        const missing = OWNER_REQUIRED_PERMISSIONS.filter(p => !permissions.includes(p));
        if (missing.length > 0) {
          res.status(400).json({
            error: 'OwnerLockout',
            message: `Cannot remove required permissions from owner role: ${missing.join(', ')}`,
          });
          return;
        }
      }
    }

    if (name && name !== currentRole.name) {
      const nameCheck = await query(
        `SELECT 1 FROM records_index WHERE community_did = $1 AND collection = $2 AND record->>'name' = $3 AND rkey != $4`,
        [communityDid, ROLE_COLLECTION, name, rkey]
      );
      if (nameCheck.rows.length > 0) {
        res.status(409).json({ error: 'RoleNameTaken', message: 'A role with this name already exists' });
        return;
      }
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);

    const updatedRecord = {
      ...currentRole,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
    };

    const result = await engine.putRecord(keypair, ROLE_COLLECTION, rkey, updatedRecord);

    await auditLog('community.role.update', req.auth!.userId, communityDid, { rkey, name: updatedRecord.name });

    res.status(200).json({ uri: result.uri, cid: result.cid });
  } catch (error) {
    console.error('Error in updateRole:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to update role' });
  }
}
