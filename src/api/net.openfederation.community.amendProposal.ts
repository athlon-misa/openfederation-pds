import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
const DEFAULT_TTL_DAYS = 7;

export default async function amendProposal(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, proposalRkey, proposedRecord, reason } = req.body;

    if (!communityDid || !proposalRkey || !proposedRecord) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing: communityDid, proposalRkey, proposedRecord' });
      return;
    }

    if (typeof proposedRecord !== 'object' || proposedRecord === null || Array.isArray(proposedRecord)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'proposedRecord must be a JSON object' });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.governance.write'
    );
    if (!hasPermission) return;

    const proposalResult = await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, PROPOSAL_COLLECTION, proposalRkey]
    );

    if (proposalResult.rows.length === 0) {
      res.status(404).json({ error: 'ProposalNotFound', message: 'No proposal found' });
      return;
    }

    const proposal = proposalResult.rows[0].record;

    if (proposal.status !== 'open') {
      res.status(400).json({ error: 'ProposalClosed', message: 'Only open proposals can be amended' });
      return;
    }

    const settingsResult = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [communityDid]
    );
    const ttlDays = settingsResult.rows[0]?.record?.governanceConfig?.proposalTtlDays || DEFAULT_TTL_DAYS;

    const amendment = {
      amendedBy: req.auth!.did,
      previousRecord: proposal.proposedRecord,
      amendedAt: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    };

    const updatedProposal = {
      ...proposal,
      proposedRecord,
      votesFor: [],
      votesAgainst: [],
      expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString(),
      amendments: [...(proposal.amendments || []), amendment],
    };

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);
    const result = await engine.putRecord(keypair, PROPOSAL_COLLECTION, proposalRkey, updatedProposal);

    await auditLog('community.proposal.amend', req.auth!.userId, communityDid, {
      rkey: proposalRkey, amendmentCount: updatedProposal.amendments.length,
    });

    res.status(200).json({
      uri: result.uri,
      cid: result.cid,
      amendmentCount: updatedProposal.amendments.length,
    });
  } catch (error) {
    console.error('Error in amendProposal:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to amend proposal' });
  }
}
