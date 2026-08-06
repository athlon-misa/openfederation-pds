import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { writeVoteRecord } from '../governance/vote-records.js';
import { EVIDENCE_MODEL_VOTE_RECORDS } from '../governance/proposal-resolution.js';

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
      // This proposal's outcome will be decided from voter-signed vote records;
      // the vote arrays above are a read cache. Proposals without this marker
      // predate the evidence model and resolve on the arrays alone.
      evidenceModel: EVIDENCE_MODEL_VOTE_RECORDS,
      // Lineage of proposal CIDs a vote record may legitimately cite; appended
      // to on every rewrite of this record.
      cidChain: [] as string[],
    };

    const result = await engine.putRecord(keypair, PROPOSAL_COLLECTION, rkey, record);

    // The proposer's seed vote is a counted vote, so it gets a voter-signed
    // record like any other — otherwise the authoritative tally would be short
    // by one from the moment the proposal exists.
    const proposerVote = await writeVoteRecord({
      voterDid: req.auth!.did,
      communityDid,
      proposalRkey: rkey,
      proposalCid: result.cid,
      vote: 'for',
    });

    await auditLog('community.proposal.create', req.auth!.userId, communityDid, {
      rkey,
      targetCollection,
      action,
      proposalCid: result.cid,
      evidenceModel: EVIDENCE_MODEL_VOTE_RECORDS,
      ...(proposerVote ? { proposerVoteUri: proposerVote.uri, proposerVoteCid: proposerVote.cid } : {}),
    });

    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in createProposal:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create proposal' });
  }
}
