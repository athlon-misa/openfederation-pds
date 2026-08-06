import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query, withAdvisoryLock } from '../db/client.js';
import {
  auditUnrecordableVote,
  canRecordVote,
  writeVoteRecords,
  type VoteRecordInput,
} from '../governance/vote-records.js';
import {
  auditDeferredResolution,
  decideFromRecords,
  decideOutcome,
  ensureDecisionRecord,
  putProposalRecord,
  quorumRule,
  tallyFromVoteRecords,
  usesVoteRecordEvidence,
  type DecisionRef,
  type Outcome,
} from '../governance/proposal-resolution.js';

const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
const DELEGATION_COLLECTION = 'net.openfederation.community.delegation';

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

    return await withAdvisoryLock(`community-proposal:${communityDid}:${proposalRkey}`, async () => {
    const proposalResult = await query<{ record: any; cid: string }>(
      `SELECT record, cid FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, PROPOSAL_COLLECTION, proposalRkey]
    );

    if (proposalResult.rows.length === 0) {
      res.status(404).json({ error: 'ProposalNotFound', message: 'No proposal found with the given rkey' });
      return;
    }

    const proposal = proposalResult.rows[0].record;
    // CID of the proposal as it stood when this vote was cast — the state the
    // voter is attesting to, captured before the tally rewrites the record.
    const proposalCid = proposalResult.rows[0].cid;
    const evidenceFromRecords = usesVoteRecordEvidence(proposal);

    if (proposal.status !== 'open') {
      res.status(400).json({ error: 'ProposalClosed', message: 'This proposal is no longer open for voting' });
      return;
    }

    if (proposal.expiresAt && new Date(proposal.expiresAt) < new Date()) {
      const engine = new RepoEngine(communityDid);
      const keypair = await getKeypairForDid(communityDid);
      await putProposalRecord(engine, keypair, communityDid, proposalRkey, {
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

    // A voter with no repo can never sign a vote record, so counting them would
    // put a permanently unevidenced name in the tally — and, because resolution
    // requires the cache and the records to agree, would deadlock this
    // community's governance. Refuse the vote here instead, where the voter
    // learns about it.
    if (evidenceFromRecords) {
      let voterCanRecord: boolean;
      try {
        voterCanRecord = await canRecordVote(voterDid);
      } catch (error) {
        // The check failed, which is not the same as "no repo". Nothing has been
        // written yet, so the honest answer is a retryable failure rather than a
        // permanent verdict on this account.
        console.error(`[governance] repo check failed for voter ${voterDid}:`, error);
        res.status(500).json({
          error: 'InternalServerError',
          message: 'Could not determine whether this vote can be recorded; please retry',
        });
        return;
      }
      if (!voterCanRecord) {
        res.status(400).json({
          error: 'VoteNotRecordable',
          message: 'This account has no repository, so its vote cannot be recorded as verifiable evidence',
        });
        return;
      }
    }

    const updatedProposal = { ...proposal };
    if (vote === 'for') {
      updatedProposal.votesFor = [...(proposal.votesFor || []), voterDid];
    } else {
      updatedProposal.votesAgainst = [...(proposal.votesAgainst || []), voterDid];
    }

    // Vote records to write into voter repos: for evidence-model proposals these
    // are the tally, so they are written before the tally is computed.
    const voteRecordInputs: VoteRecordInput[] = [
      { voterDid, communityDid, proposalRkey, proposalCid, vote },
    ];

    // Delegation counting: find members who delegated to this voter
    const delegations = await query<{ record: any; rkey: string; cid: string }>(
      `SELECT record, rkey, cid FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'delegateDid' = $3`,
      [communityDid, DELEGATION_COLLECTION, voterDid]
    );

    for (const del of delegations.rows) {
      const delegatorDid = del.record?.delegatorDid;
      if (!delegatorDid) continue;
      // Skip if delegator already voted directly on this proposal
      if (updatedProposal.votesFor.includes(delegatorDid) || updatedProposal.votesAgainst.includes(delegatorDid)) continue;
      // Same rule as for the direct voter: a delegator who cannot produce a
      // vote record is not counted. The delegate's own vote still stands, so
      // this is dropped and audited rather than raised.
      const delegatedVote: VoteRecordInput = {
        voterDid: delegatorDid,
        communityDid,
        proposalRkey,
        proposalCid,
        vote,
        castBy: voterDid,
        delegation: {
          uri: `at://${communityDid}/${DELEGATION_COLLECTION}/${del.rkey}`,
          cid: del.cid,
        },
      };
      if (evidenceFromRecords) {
        let delegatorCanRecord = true;
        try {
          delegatorCanRecord = await canRecordVote(delegatorDid);
        } catch (error) {
          // A failed check is not a determination that this delegator has no
          // repo. Dropping the vote on that basis would remove it from the
          // cache and the record set at once — the two would agree without it
          // and the proposal would resolve as if the delegation never existed.
          // Keep counting it: writeVoteRecords will make the real attempt and
          // audit the real reason if it fails, and the cache/record divergence
          // defers the resolution rather than deciding it.
          console.error(`[governance] repo check failed for delegator ${delegatorDid}:`, error);
        }
        if (!delegatorCanRecord) {
          await auditUnrecordableVote(delegatedVote);
          continue;
        }
      }
      // Add delegator's vote in same direction as delegate
      if (vote === 'for') {
        updatedProposal.votesFor.push(delegatorDid);
      } else {
        updatedProposal.votesAgainst.push(delegatorDid);
      }
      voteRecordInputs.push(delegatedVote);
    }

    // Voter-signed vote records in each voter's own repo. Written first: for
    // evidence-model proposals the tally below is computed from them. Failures
    // are logged inside writeVoteRecords and never change the response — the
    // resulting gap is reconciled against the vote cache at resolution.
    const writtenVoteRecords = await writeVoteRecords(voteRecordInputs);

    const settingsResult = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [communityDid]
    );
    const settings = settingsResult.rows[0]?.record;
    const quorum = settings?.governanceConfig?.quorum || 3;

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);

    let outcome: Outcome | null = null;
    let deferred = false;
    let decision: DecisionRef | undefined;
    let countedVoteCids: string[] = [];
    let evidenceComplete = true;

    if (evidenceFromRecords) {
      const tally = await tallyFromVoteRecords({
        communityDid, proposalRkey, proposal: updatedProposal, proposalCid,
      });
      const decided = decideFromRecords({ tally, proposal: updatedProposal, quorum });
      deferred = decided.deferred;
      outcome = decided.outcome;
      countedVoteCids = [...tally.votesFor, ...tally.votesAgainst].map(v => v.record.cid);
      evidenceComplete = tally.uncounted.length === 0;

      if (deferred) {
        await auditDeferredResolution({
          communityDid,
          proposalRkey,
          tally,
          recordOutcome: decideOutcome(tally.votesFor.length, tally.votesAgainst.length, quorum),
          cacheOutcome: decided.cacheOutcome,
          quorum,
        });
      }

      if (outcome) {
        // Decision record first, so the proposal is never closed while citing a
        // decision that does not exist. A crash here leaves the proposal open
        // and the retry reuses this record.
        decision = await ensureDecisionRecord({
          engine,
          keypair,
          communityDid,
          proposalRkey,
          proposalCid,
          proposal: updatedProposal,
          tally,
          quorum: quorumRule(settings?.governanceModel ?? 'simple-majority', quorum),
          outcome,
        });
      }
    } else {
      // Proposals created before the vote-record evidence model resolve on the
      // cached arrays exactly as they always did.
      const cachedFor = updatedProposal.votesFor.length;
      const cachedAgainst = updatedProposal.votesAgainst.length;
      outcome = decideOutcome(cachedFor, cachedAgainst, quorum);
    }

    let applied = false;

    if (outcome) {
      updatedProposal.status = outcome;
      updatedProposal.resolvedAt = new Date().toISOString();
      if (decision) {
        updatedProposal.decision = { uri: decision.uri, cid: decision.cid, rkey: decision.rkey };
      }

      // Closing the proposal before applying the change keeps the change
      // single-shot: a crash after this point cannot re-enter the apply step,
      // because the proposal is no longer open.
      await putProposalRecord(engine, keypair, communityDid, proposalRkey, updatedProposal);

      if (outcome === 'approved') {
        if (proposal.action === 'write' && proposal.proposedRecord) {
          await engine.putRecord(keypair, proposal.targetCollection, proposal.targetRkey, proposal.proposedRecord);
        } else if (proposal.action === 'delete') {
          await engine.deleteRecord(keypair, proposal.targetCollection, proposal.targetRkey);
        }
        applied = true;
        await auditLog('community.proposal.approve', req.auth!.userId, communityDid, {
          rkey: proposalRkey,
          targetCollection: proposal.targetCollection,
          applied,
          ...(decision ? { decisionUri: decision.uri, decisionCid: decision.cid, countedVoteCids, evidenceComplete } : {}),
        });
      } else {
        await auditLog('community.proposal.reject', req.auth!.userId, communityDid, {
          rkey: proposalRkey,
          ...(decision ? { decisionUri: decision.uri, decisionCid: decision.cid, countedVoteCids, evidenceComplete } : {}),
        });
      }
    } else {
      await putProposalRecord(engine, keypair, communityDid, proposalRkey, updatedProposal);
    }

    await auditLog('community.proposal.vote', req.auth!.userId, communityDid, {
      rkey: proposalRkey,
      vote,
      proposalCid,
      voteRecords: writtenVoteRecords.map(r => ({ voter: r.voterDid, uri: r.uri, cid: r.cid })),
    });

    res.status(200).json({
      recorded: true,
      status: updatedProposal.status,
      ...(applied ? { applied: true } : {}),
      ...(deferred ? { resolutionDeferred: true } : {}),
    });
    });
  } catch (error) {
    console.error('Error in voteOnProposal:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to record vote' });
  }
}
