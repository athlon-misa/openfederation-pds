import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
const DEFAULT_TTL_DAYS = 7;

export default async function createProposal(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, targetCollection, targetRkey, action, proposedRecord } = req.body;

    if (!communityDid || !targetCollection || !targetRkey || !action) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, targetCollection, targetRkey, action',
      });
      return;
    }

    if (!['write', 'delete'].includes(action)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'action must be "write" or "delete"' });
      return;
    }

    if (action === 'write' && (!proposedRecord || typeof proposedRecord !== 'object')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'proposedRecord is required for write action' });
      return;
    }

    const settingsResult = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [communityDid]
    );

    const settings = settingsResult.rows[0]?.record;
    if (!settings || settings.governanceModel !== 'simple-majority') {
      res.status(400).json({
        error: 'GovernanceNotActive',
        message: 'Community is not using simple-majority governance',
      });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.governance.write'
    );
    if (!hasPermission) return;

    const ttlDays = settings.governanceConfig?.proposalTtlDays || DEFAULT_TTL_DAYS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);
    const rkey = RepoEngine.generateTid();

    const record = {
      targetCollection,
      targetRkey,
      action,
      ...(proposedRecord ? { proposedRecord } : {}),
      proposedBy: req.auth!.did,
      status: 'open',
      votesFor: [req.auth!.did],
      votesAgainst: [] as string[],
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      resolvedAt: null,
    };

    const result = await engine.putRecord(keypair, PROPOSAL_COLLECTION, rkey, record);

    await auditLog('community.proposal.create', req.auth!.userId, communityDid, {
      rkey, targetCollection, action,
    });

    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in createProposal:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create proposal' });
  }
}
