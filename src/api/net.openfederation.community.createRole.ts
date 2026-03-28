import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, ALL_PERMISSIONS } from '../auth/permissions.js';

export default async function createRole(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, name, description, permissions } = req.body;

    if (!communityDid || !name || !permissions) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: communityDid, name, permissions' });
      return;
    }

    if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
      res.status(400).json({ error: 'InvalidRequest', message: 'name must be 1-64 characters' });
      return;
    }

    if (!Array.isArray(permissions)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'permissions must be an array' });
      return;
    }

    const invalid = permissions.filter((p: string) => !ALL_PERMISSIONS.includes(p as any));
    if (invalid.length > 0) {
      res.status(400).json({ error: 'InvalidRequest', message: `Invalid permissions: ${invalid.join(', ')}` });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.role.write'
    );
    if (!hasPermission) return;

    const existing = await query(
      `SELECT 1 FROM records_index WHERE community_did = $1 AND collection = $2 AND record->>'name' = $3`,
      [communityDid, ROLE_COLLECTION, name]
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'RoleNameTaken', message: 'A role with this name already exists' });
      return;
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);
    const rkey = RepoEngine.generateTid();

    const record = { name, ...(description ? { description } : {}), permissions };
    const result = await engine.putRecord(keypair, ROLE_COLLECTION, rkey, record);

    await auditLog('community.role.create', req.auth!.userId, communityDid, { rkey, name });

    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in createRole:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create role' });
  }
}
