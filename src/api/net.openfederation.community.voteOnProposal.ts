import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';

export default async function voteOnProposal(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, proposalRkey, vote } = req.body;

    if (!communityDid || !proposalRkey || !vote) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: communityDid, proposalRkey, vote' });
      return;
    }

    if (!['for', 'against'].includes(vote)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'vote must be "for" or "against"' });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.governance.write'
    );
    if (!hasPermission) return;

    const proposalResult = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, PROPOSAL_COLLECTION, proposalRkey]
    );

    if (proposalResult.rows.length === 0) {
      res.status(404).json({ error: 'ProposalNotFound', message: 'No proposal found with the given rkey' });
      return;
    }

    const proposal = proposalResult.rows[0].record;

    if (proposal.status !== 'open') {
      res.status(400).json({ error: 'ProposalClosed', message: 'This proposal is no longer open for voting' });
      return;
    }

    if (proposal.expiresAt && new Date(proposal.expiresAt) < new Date()) {
      const engine = new RepoEngine(communityDid);
      const keypair = await getKeypairForDid(communityDid);
      await engine.putRecord(keypair, PROPOSAL_COLLECTION, proposalRkey, {
        ...proposal, status: 'expired', resolvedAt: new Date().toISOString(),
      });
      await auditLog('community.proposal.expire', null, communityDid, { rkey: proposalRkey });
      res.status(400).json({ error: 'ProposalClosed', message: 'This proposal has expired' });
      return;
    }

    const voterDid = req.auth!.did;
    if (proposal.votesFor?.includes(voterDid) || proposal.votesAgainst?.includes(voterDid)) {
      res.status(409).json({ error: 'AlreadyVoted', message: 'You have already voted on this proposal' });
      return;
    }

    const updatedProposal = { ...proposal };
    if (vote === 'for') {
      updatedProposal.votesFor = [...(proposal.votesFor || []), voterDid];
    } else {
      updatedProposal.votesAgainst = [...(proposal.votesAgainst || []), voterDid];
    }

    const settingsResult = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [communityDid]
    );
    const quorum = settingsResult.rows[0]?.record?.governanceConfig?.quorum || 3;

    const totalVotes = updatedProposal.votesFor.length + updatedProposal.votesAgainst.length;
    let applied = false;

    if (totalVotes >= quorum) {
      if (updatedProposal.votesFor.length > updatedProposal.votesAgainst.length) {
        updatedProposal.status = 'approved';
        updatedProposal.resolvedAt = new Date().toISOString();

        const engine = new RepoEngine(communityDid);
        const keypair = await getKeypairForDid(communityDid);

        await engine.putRecord(keypair, PROPOSAL_COLLECTION, proposalRkey, updatedProposal);

        if (proposal.action === 'write' && proposal.proposedRecord) {
          await engine.putRecord(keypair, proposal.targetCollection, proposal.targetRkey, proposal.proposedRecord);
        } else if (proposal.action === 'delete') {
          await engine.deleteRecord(keypair, proposal.targetCollection, proposal.targetRkey);
        }

        applied = true;
        await auditLog('community.proposal.approve', req.auth!.userId, communityDid, {
          rkey: proposalRkey, targetCollection: proposal.targetCollection, applied,
        });
      } else {
        updatedProposal.status = 'rejected';
        updatedProposal.resolvedAt = new Date().toISOString();

        const engine = new RepoEngine(communityDid);
        const keypair = await getKeypairForDid(communityDid);
        await engine.putRecord(keypair, PROPOSAL_COLLECTION, proposalRkey, updatedProposal);

        await auditLog('community.proposal.reject', req.auth!.userId, communityDid, { rkey: proposalRkey });
      }
    } else {
      const engine = new RepoEngine(communityDid);
      const keypair = await getKeypairForDid(communityDid);
      await engine.putRecord(keypair, PROPOSAL_COLLECTION, proposalRkey, updatedProposal);
    }

    await auditLog('community.proposal.vote', req.auth!.userId, communityDid, {
      rkey: proposalRkey, vote,
    });

    res.status(200).json({
      recorded: true,
      status: updatedProposal.status,
      ...(applied ? { applied: true } : {}),
    });
  } catch (error) {
    console.error('Error in voteOnProposal:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to record vote' });
  }
}
