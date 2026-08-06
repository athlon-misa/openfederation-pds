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
import { anchorDecision, anchorPendingDecisions } from '../governance/anchoring.js';
import {
  OVERRIDE_STATUS,
  PENDING_STATUS,
  applyDueProposals,
  applyProposedChange,
  closeExpiredOverrides,
  pendingApplicationState,
  proposalApplicationProblem,
  proposalLockKey,
} from '../governance/timelock.js';
import { decideOverride } from '../governance/decision-rules.js';

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

    // Lazy timelock evaluation, before the per-proposal lock is taken: any
    // proposal in this community whose contest window has elapsed is applied
    // now. `applyDueProposals` takes each proposal's lock itself, so it must not
    // run inside the one below.
    await applyDueProposals(communityDid);
    // ...and any override round that ran out of time, for the same reason and by
    // the same rule: no scheduler exists, so an elapsed window is closed by the
    // next interaction that touches this community's proposals (#199).
    await closeExpiredOverrides(communityDid);

    // The lock covers the decision and everything it changes, and nothing else.
    // What it deliberately does NOT cover is anchoring: that call waits on a
    // third party, and holding a governance advisory lock (and a connection from
    // the lock pool) for the length of somebody else's network timeout would
    // make an unavailable notary a contention problem for the whole community.
    // The closure hands back what the anchoring step needs, and the response is
    // sent after it, so a receipt is recorded before the caller is told the
    // proposal resolved.
    const resolved = await withAdvisoryLock(proposalLockKey(communityDid, proposalRkey), async () => {
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

    // A held proposal in its override round accepts votes, and that is the only
    // second round there is: the electorate answers a higher bar (#199).
    const overrideRound = proposal.status === OVERRIDE_STATUS;
    if (proposal.status !== 'open' && !overrideRound) {
      res.status(400).json({ error: 'ProposalClosed', message: 'This proposal is no longer open for voting' });
      return;
    }

    if (overrideRound) {
      const expiresAt = typeof proposal.overrideExpiresAt === 'string' ? proposal.overrideExpiresAt : null;
      // Reached only when the sweep above could not close the round. The window
      // is over either way, and a late vote does not carry an override.
      if (!expiresAt || new Date().toISOString() >= expiresAt) {
        res.status(400).json({
          error: 'ProposalClosed',
          message: 'The override round for this proposal has closed',
        });
        return;
      }
    }

    // `expiresAt` bounds the *original* round. An override round has its own
    // window, checked above; letting the original one expire it would close a
    // round that had only just opened, since a hold necessarily happens after
    // the proposal was decided and often after it would have expired unvoted.
    if (!overrideRound && proposal.expiresAt && new Date(proposal.expiresAt) < new Date()) {
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
    const ordinaryQuorum = settings?.governanceConfig?.quorum || 3;

    // The bar this round answers to. An override round's bar was computed and
    // frozen onto the proposal when the round opened, so it cannot be moved
    // mid-round by editing the settings or by changing who is a member.
    const overrideQuorum = overrideRound && typeof proposal.overrideQuorum === 'number'
      ? proposal.overrideQuorum
      : null;
    const quorum = overrideQuorum ?? ordinaryQuorum;

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
      // An override round is decided by a different rule, not a different
      // number: only votes *for* count, because the round asks whether a
      // stronger mandate exists than the one that was objected to, and
      // abstention and opposition answer that the same way. It cannot resolve
      // to `rejected` from a vote either — falling short is what the round's
      // expiry is for, so the round stays open until the bar is cleared or the
      // window closes.
      const recordOutcome = overrideQuorum === null
        ? decideOutcome(tally.votesFor.length, tally.votesAgainst.length, quorum)
        : decideOverride(tally.votesFor.length, overrideQuorum);
      const cacheOutcome = overrideQuorum === null
        ? decideOutcome(updatedProposal.votesFor.length, updatedProposal.votesAgainst.length, quorum)
        : decideOverride(updatedProposal.votesFor.length, overrideQuorum);

      // The cache and the records must agree before anything is decided, in
      // both rounds and for the same reason: a divergence means some vote
      // record could not be written, and resolving on either side alone would
      // decide on evidence that does not exist or ignore evidence that does.
      const decided = overrideQuorum === null
        ? decideFromRecords({ tally, proposal: updatedProposal, quorum })
        : { outcome: recordOutcome === cacheOutcome ? recordOutcome : null, deferred: recordOutcome !== cacheOutcome, cacheOutcome };
      deferred = decided.deferred;
      outcome = decided.outcome;
      countedVoteCids = [...tally.votesFor, ...tally.votesAgainst].map(v => v.record.cid);
      evidenceComplete = tally.uncounted.length === 0;

      if (deferred) {
        await auditDeferredResolution({
          communityDid,
          proposalRkey,
          tally,
          recordOutcome,
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
      outcome = overrideQuorum === null
        ? decideOutcome(cachedFor, cachedAgainst, quorum)
        : decideOverride(cachedFor, overrideQuorum);
    }

    let applied = false;
    let pendingApplication: string | undefined;
    let overrideRefusal: string | null = null;

    if (outcome) {
      const resolvedAt = new Date().toISOString();
      updatedProposal.status = outcome;
      updatedProposal.resolvedAt = resolvedAt;
      if (decision) {
        updatedProposal.decision = { uri: decision.uri, cid: decision.cid, rkey: decision.rkey };
      }

      // An approved change waits out the community's contest window before it
      // touches the repo. Only decisions carry something an objection can name,
      // so proposals predating the evidence model apply as they always did
      // rather than entering a window nobody could contest.
      //
      // An override that carries applies at once. It has already served a full
      // contest window — that window is what produced the objection that opened
      // this round — and objecting again is refused by `objectToProposal`, so a
      // second window would be a delay nobody could use (#199).
      const window = outcome === 'approved' && decision && !overrideRound
        ? pendingApplicationState(settings, resolvedAt)
        : null;
      if (overrideRound && outcome === 'approved') {
        updatedProposal.overrideOutcome = 'carried';
        // Whether the change *can* be made is settled before the record claims
        // it was, exactly as `applyIfDue` settles it: discovering the refusal
        // afterwards would leave a signed record asserting an `appliedAt` that
        // never happened, contradicted only by an audit row. A refused change
        // still closes the proposal — the override carried, and the decision
        // stands — it simply makes no claim to have taken effect.
        overrideRefusal = await proposalApplicationProblem(communityDid, proposal);
        if (!overrideRefusal) updatedProposal.appliedAt = resolvedAt;
      }
      if (window) {
        updatedProposal.status = PENDING_STATUS;
        updatedProposal.applyAt = window.applyAt;
        pendingApplication = window.applyAt;
      }

      // Closing the proposal before applying the change keeps the change
      // single-shot: a crash after this point cannot re-enter the apply step,
      // because the proposal is no longer open.
      await putProposalRecord(engine, keypair, communityDid, proposalRkey, updatedProposal);

      if (overrideRound && outcome === 'approved') {
        await auditLog('community.proposal.overrideCarried', req.auth!.userId, communityDid, {
          rkey: proposalRkey,
          targetCollection: proposal.targetCollection,
          overrideQuorum,
          overrideOpenedAt: proposal.overrideOpenedAt,
          resolvedAt,
          ...(decision ? { decisionUri: decision.uri, decisionCid: decision.cid, countedVoteCids, evidenceComplete } : {}),
        });
      }

      if (window) {
        await auditLog('community.proposal.pendingApplication', req.auth!.userId, communityDid, {
          rkey: proposalRkey,
          targetCollection: proposal.targetCollection,
          applyAt: window.applyAt,
          resolvedAt,
          ...(decision ? { decisionUri: decision.uri, decisionCid: decision.cid, countedVoteCids, evidenceComplete } : {}),
        });
      } else if (outcome === 'approved' && overrideRefusal) {
        // Settled above, before the record was written. Named as withheld
        // rather than silently skipped.
        await auditLog('community.proposal.applyFailed', req.auth!.userId, communityDid, {
          rkey: proposalRkey,
          targetCollection: proposal.targetCollection,
          reason: overrideRefusal,
        });
      } else if (outcome === 'approved') {
        // The change can be refused at this point — a settings proposal that
        // would leave the community with a model nothing recognizes is not
        // applied (see `applyProposedChange`). The decision still stands and is
        // still recorded; only the effect is withheld, and named as withheld,
        // exactly as the lazy timelock path does through `applyIfDueSafely`.
        try {
          await applyProposedChange(engine, keypair, proposal);
          applied = true;
        } catch (error) {
          console.error(`[governance] could not apply ${communityDid}/${proposalRkey}:`, error);
          await auditLog('community.proposal.applyFailed', req.auth!.userId, communityDid, {
            rkey: proposalRkey,
            targetCollection: proposal.targetCollection,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
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

    return {
      payload: {
        recorded: true,
        status: updatedProposal.status,
        ...(applied ? { applied: true } : {}),
        // Decided, not yet effective. Distinct from `resolutionDeferred`, which
        // means nothing was decided at all.
        ...(pendingApplication ? { pendingApplication: true, applyAt: pendingApplication } : {}),
        ...(deferred ? { resolutionDeferred: true } : {}),
      },
      decision,
      settings,
    };
    });

    // An early return inside the closure has already answered the request.
    if (!resolved) return;

    // Notarization, strictly after the fact and outside the lock. Everything
    // this resolution does to the community's data — the decision record, the
    // proposal rewrite, the application or the pending window, and their audit
    // entries — is already committed. Anchoring returns nothing that is read
    // back and cannot throw: an attestor that is absent, slow, or failing
    // leaves a retriable audit entry and an otherwise identical outcome.
    if (resolved.decision) {
      const receipt = await anchorDecision({
        communityDid, proposalRkey, decision: resolved.decision, settings: resolved.settings,
      });
      // Only drain the backlog when the notary has just demonstrated it is
      // answering. Retrying against one that has already failed this request
      // would spend a timeout per stale entry inside a member's vote. The drain
      // carries its own wall-clock budget on top of that.
      if (receipt) await anchorPendingDecisions({ communityDid, settings: resolved.settings });
    }

    res.status(200).json(resolved.payload);
  } catch (error) {
    console.error('Error in voteOnProposal:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to record vote' });
  }
}
