import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

const DELEGATION_COLLECTION = 'net.openfederation.community.delegation';

export default async function revokeDelegation(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid } = req.body;

    if (!communityDid) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing: communityDid' });
      return;
    }

    const existing = await query<{ rkey: string }>(
      `SELECT rkey FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'delegatorDid' = $3`,
      [communityDid, DELEGATION_COLLECTION, req.auth!.did]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'No active delegation found' });
      return;
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);
    await engine.deleteRecord(keypair, DELEGATION_COLLECTION, existing.rows[0].rkey);

    await auditLog('community.delegation.revoke', req.auth!.userId, communityDid, {});

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in revokeDelegation:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to revoke delegation' });
  }
}
