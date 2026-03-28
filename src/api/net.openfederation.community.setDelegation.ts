import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

const DELEGATION_COLLECTION = 'net.openfederation.community.delegation';

export default async function setDelegation(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, delegateDid } = req.body;

    if (!communityDid || !delegateDid) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing: communityDid, delegateDid' });
      return;
    }

    if (delegateDid === req.auth!.did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Cannot delegate to yourself' });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.governance.write'
    );
    if (!hasPermission) return;

    const delegateMember = await query(
      'SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [communityDid, delegateDid]
    );
    if (delegateMember.rows.length === 0) {
      res.status(404).json({ error: 'NotMember', message: 'Delegate is not a community member' });
      return;
    }

    const existing = await query<{ rkey: string }>(
      `SELECT rkey FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'delegatorDid' = $3`,
      [communityDid, DELEGATION_COLLECTION, req.auth!.did]
    );

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);

    if (existing.rows.length > 0) {
      await engine.deleteRecord(keypair, DELEGATION_COLLECTION, existing.rows[0].rkey);
    }

    const rkey = RepoEngine.generateTid();
    const record = {
      delegatorDid: req.auth!.did,
      delegateDid,
      createdAt: new Date().toISOString(),
    };

    const result = await engine.putRecord(keypair, DELEGATION_COLLECTION, rkey, record);

    await auditLog('community.delegation.set', req.auth!.userId, communityDid, { delegateDid });

    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in setDelegation:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to set delegation' });
  }
}
