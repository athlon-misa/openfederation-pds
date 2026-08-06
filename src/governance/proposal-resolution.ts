/**
 * Authoritative governance tally, computed from voter-signed vote records.
 *
 * Task 3 made every counted vote produce a `net.openfederation.governance.vote`
 * record in the voter's own repo, signed with the voter's key — but the
 * proposal's `votesFor` / `votesAgainst` arrays stayed authoritative. Here the
 * authority flips: an outcome is decided from the vote records alone, and the
 * arrays become a non-authoritative read cache that endpoints keep updating for
 * cheap reads.
 *
 * Two categories of counted vote can legitimately lack a record: voters with no
 * repo (external accounts, the bootstrap admin), and — before this change — the
 * proposer's seed vote, which `createProposal` wrote straight into `votesFor`.
 * The seed vote now produces a record like any other. Whatever gap remains is
 * handled explicitly rather than absorbed:
 *
 *   - Cache-only votes are never counted (counting them would mean trusting the
 *     operator's assertion, which is exactly what this refactor removes), but
 *     they are enumerated on the decision record as `uncountedVotes`.
 *   - Before resolving, the record-derived outcome is compared against the
 *     outcome the cache alone would have produced. If they disagree, the
 *     proposal is NOT resolved: it stays open and the divergence is audited.
 *     So a missing record can delay a resolution, but it can never flip one,
 *     and it can never cause a change to be applied on evidence that isn't
 *     there.
 *
 * Proposals created before this change carry no `evidenceModel` marker and are
 * resolved by the old array arithmetic; nothing is rewritten retroactively.
 */

import type { Keypair } from '@atproto/crypto';
import { RepoEngine } from '../repo/repo-engine.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { PROPOSAL_COLLECTION, VOTE_COLLECTION } from './vote-records.js';

export const DECISION_COLLECTION = 'net.openfederation.governance.decision';

/** Marker on proposals whose outcome is decided from vote records. */
export const EVIDENCE_MODEL_VOTE_RECORDS = 'vote-records';

/** Upper bound on the retained proposal CID lineage. */
const MAX_CID_CHAIN = 500;

export type VoteChoice = 'for' | 'against';
export type Outcome = 'approved' | 'rejected';

export interface CountedVote {
  voter: string;
  vote: VoteChoice;
  record: { uri: string; cid: string };
  proposalCid: string;
  castBy?: string;
}

export interface UncountedVote {
  voter: string;
  vote: VoteChoice;
  reason: string;
}

export interface RecordTally {
  votesFor: CountedVote[];
  votesAgainst: CountedVote[];
  uncounted: UncountedVote[];
}

export interface QuorumRule {
  model: string;
  threshold: number;
  rule: string;
}

export function proposalUri(communityDid: string, proposalRkey: string): string {
  return `at://${communityDid}/${PROPOSAL_COLLECTION}/${proposalRkey}`;
}

/** Proposals created before this change keep the old array-based mechanics. */
export function usesVoteRecordEvidence(proposal: any): boolean {
  return proposal?.evidenceModel === EVIDENCE_MODEL_VOTE_RECORDS;
}

/**
 * Every proposal CID a vote may legitimately cite: the current one plus the
 * lineage of states the proposal passed through, maintained by
 * `putProposalRecord`.
 */
export function knownProposalCids(proposal: any, currentCid: string): Set<string> {
  const chain: unknown = proposal?.cidChain;
  const cids = new Set<string>(Array.isArray(chain) ? chain.filter((c): c is string => typeof c === 'string') : []);
  cids.add(currentCid);
  return cids;
}

/**
 * Votes cast before an amendment do not carry over: `amendProposal` clears the
 * vote cache, so the record tally has to start from the same point.
 */
function tallyEpoch(proposal: any): string | null {
  const amendments = Array.isArray(proposal?.amendments) ? proposal.amendments : [];
  const last = amendments[amendments.length - 1];
  const epoch = last?.amendedAt ?? proposal?.createdAt;
  return typeof epoch === 'string' ? epoch : null;
}

/**
 * Write the proposal record, appending the state it replaces to the proposal's
 * CID lineage. Vote records cite the proposal CID they saw; the lineage is what
 * makes that citation checkable after later votes have rewritten the record.
 */
export async function putProposalRecord(
  engine: RepoEngine,
  keypair: Keypair,
  communityDid: string,
  proposalRkey: string,
  record: Record<string, unknown>,
): Promise<{ uri: string; cid: string }> {
  if (record.evidenceModel !== EVIDENCE_MODEL_VOTE_RECORDS) {
    return engine.putRecord(keypair, PROPOSAL_COLLECTION, proposalRkey, record);
  }

  const current = await query<{ cid: string }>(
    `SELECT cid FROM records_index
     WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, PROPOSAL_COLLECTION, proposalRkey],
  );

  const existing: string[] = Array.isArray(record.cidChain)
    ? (record.cidChain as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  const previousCid = current.rows[0]?.cid;
  const chain = previousCid && !existing.includes(previousCid) ? [...existing, previousCid] : existing;

  return engine.putRecord(keypair, PROPOSAL_COLLECTION, proposalRkey, {
    ...record,
    cidChain: chain.slice(-MAX_CID_CHAIN),
  });
}

interface VoteRow {
  repo_did: string;
  rkey: string;
  cid: string;
  record: any;
}

/**
 * Compute the authoritative tally for a proposal from the vote records held in
 * voters' own repos, and enumerate the cached votes that produced none.
 */
export async function tallyFromVoteRecords(input: {
  communityDid: string;
  proposalRkey: string;
  proposal: any;
  proposalCid: string;
}): Promise<RecordTally> {
  const { communityDid, proposalRkey, proposal, proposalCid } = input;
  const uri = proposalUri(communityDid, proposalRkey);
  const knownCids = knownProposalCids(proposal, proposalCid);
  const epoch = tallyEpoch(proposal);

  const rows = await query<VoteRow>(
    `SELECT community_did AS repo_did, rkey, cid, record
     FROM records_index
     WHERE collection = $1
       AND record->>'community' = $2
       AND record->>'proposalRkey' = $3`,
    [VOTE_COLLECTION, communityDid, proposalRkey],
  );

  /** voter DID -> the record that counts for them, plus why others didn't. */
  const counted = new Map<string, CountedVote>();
  const rejected = new Map<string, string>();
  const orderKey = new Map<string, string>();

  for (const row of rows.rows) {
    const record = row.record ?? {};
    const voter = row.repo_did;
    const vote = record.vote;

    const reject = (reason: string) => {
      if (!counted.has(voter) && !rejected.has(voter)) rejected.set(voter, reason);
    };

    if (vote !== 'for' && vote !== 'against') {
      reject('invalid-vote-value');
      continue;
    }
    // The vote must point at this exact proposal record, not merely mention it.
    if (record.proposal?.uri !== uri || record.proposalCollection !== PROPOSAL_COLLECTION) {
      reject('proposal-uri-mismatch');
      continue;
    }
    // ...and at a state this proposal actually passed through.
    if (typeof record.proposal?.cid !== 'string' || !knownCids.has(record.proposal.cid)) {
      reject('unknown-proposal-cid');
      continue;
    }
    // Votes predating the latest amendment were cleared from the tally.
    const createdAt = typeof record.createdAt === 'string' ? record.createdAt : '';
    if (epoch && createdAt < epoch) {
      reject('stale-vote-record');
      continue;
    }

    // One vote per voter: earliest record wins, deterministically.
    const key = `${createdAt}|${row.rkey}`;
    const previous = orderKey.get(voter);
    if (previous !== undefined && previous <= key) continue;

    orderKey.set(voter, key);
    rejected.delete(voter);
    counted.set(voter, {
      voter,
      vote,
      record: { uri: `at://${voter}/${VOTE_COLLECTION}/${row.rkey}`, cid: row.cid },
      proposalCid: record.proposal.cid,
      ...(typeof record.castBy === 'string' ? { castBy: record.castBy } : {}),
    });
  }

  const cachedFor: string[] = Array.isArray(proposal?.votesFor) ? proposal.votesFor : [];
  const cachedAgainst: string[] = Array.isArray(proposal?.votesAgainst) ? proposal.votesAgainst : [];

  const uncounted: UncountedVote[] = [];
  for (const [voter, vote] of [
    ...cachedFor.map((did: string) => [did, 'for'] as const),
    ...cachedAgainst.map((did: string) => [did, 'against'] as const),
  ]) {
    if (counted.has(voter)) continue;
    uncounted.push({ voter, vote, reason: rejected.get(voter) ?? 'no-vote-record' });
  }

  const votes = [...counted.values()];
  return {
    votesFor: votes.filter(v => v.vote === 'for'),
    votesAgainst: votes.filter(v => v.vote === 'against'),
    uncounted,
  };
}

/** The quorum rule applied to a counted tally. Null means "not yet resolvable". */
export function decideOutcome(votesFor: number, votesAgainst: number, quorum: number): Outcome | null {
  if (votesFor + votesAgainst < quorum) return null;
  return votesFor > votesAgainst ? 'approved' : 'rejected';
}

export function quorumRule(model: string, threshold: number): QuorumRule {
  return {
    model,
    threshold,
    rule: `resolves once counted votes >= ${threshold}; approved when votes for exceed votes against`,
  };
}

/**
 * Decide a proposal from its vote records.
 *
 * Returns the outcome only when the vote records and the vote cache agree on
 * it. When they disagree the proposal is left open (`deferred`) so a missing or
 * unverifiable record can never change what happens to the community's data.
 */
export function decideFromRecords(input: {
  tally: RecordTally;
  proposal: any;
  quorum: number;
}): { outcome: Outcome | null; deferred: boolean; cacheOutcome: Outcome | null } {
  const { tally, proposal, quorum } = input;
  const cachedFor: string[] = Array.isArray(proposal?.votesFor) ? proposal.votesFor : [];
  const cachedAgainst: string[] = Array.isArray(proposal?.votesAgainst) ? proposal.votesAgainst : [];

  const recordOutcome = decideOutcome(tally.votesFor.length, tally.votesAgainst.length, quorum);
  const cacheOutcome = decideOutcome(cachedFor.length, cachedAgainst.length, quorum);

  if (recordOutcome !== cacheOutcome) {
    return { outcome: null, deferred: true, cacheOutcome };
  }
  return { outcome: recordOutcome, deferred: false, cacheOutcome };
}

export interface DecisionRef {
  uri: string;
  cid: string;
  rkey: string;
}

/**
 * Write the decision record into the community repo, or return the one already
 * written for this proposal.
 *
 * Resolution order is: decision record first, then the proposal status rewrite,
 * then the proposed change. A crash before the status rewrite leaves a decision
 * record with the proposal still open — the retry finds and reuses it rather
 * than minting a second decision, and the proposed change is still applied
 * exactly once because it only ever runs after the status rewrite closes the
 * proposal.
 */
export async function ensureDecisionRecord(input: {
  engine: RepoEngine;
  keypair: Keypair;
  communityDid: string;
  proposalRkey: string;
  proposalCid: string;
  proposal: any;
  tally: RecordTally;
  quorum: QuorumRule;
  outcome: Outcome;
}): Promise<DecisionRef> {
  const { engine, keypair, communityDid, proposalRkey, proposalCid, proposal, tally, quorum, outcome } = input;

  const existing = await query<{ rkey: string; cid: string }>(
    `SELECT rkey, cid FROM records_index
     WHERE community_did = $1 AND collection = $2 AND record->>'proposalRkey' = $3
     ORDER BY rkey ASC LIMIT 1`,
    [communityDid, DECISION_COLLECTION, proposalRkey],
  );
  if (existing.rows.length > 0) {
    const { rkey, cid } = existing.rows[0];
    return { uri: `at://${communityDid}/${DECISION_COLLECTION}/${rkey}`, cid, rkey };
  }

  const votes = [...tally.votesFor, ...tally.votesAgainst];
  const rkey = RepoEngine.generateTid();
  const record: Record<string, unknown> = {
    $type: DECISION_COLLECTION,
    community: communityDid,
    proposal: { uri: proposalUri(communityDid, proposalRkey), cid: proposalCid },
    proposalCollection: PROPOSAL_COLLECTION,
    proposalRkey,
    outcome,
    quorum,
    tally: {
      votesFor: tally.votesFor.length,
      votesAgainst: tally.votesAgainst.length,
      total: votes.length,
    },
    votes,
    ...(tally.uncounted.length > 0 ? { uncountedVotes: tally.uncounted } : {}),
    evidenceComplete: tally.uncounted.length === 0,
    ...(proposal?.targetCollection && proposal?.targetRkey && proposal?.action
      ? {
          action: {
            targetCollection: proposal.targetCollection,
            targetRkey: proposal.targetRkey,
            action: proposal.action,
          },
        }
      : {}),
    resolvedAt: new Date().toISOString(),
  };

  const { uri, cid } = await engine.putRecord(keypair, DECISION_COLLECTION, rkey, record);
  return { uri, cid, rkey };
}

/**
 * Record a resolution that was withheld because the vote records and the vote
 * cache disagree about the outcome. The proposal stays open; this entry is how
 * the disagreement is found afterwards.
 */
export async function auditDeferredResolution(input: {
  communityDid: string;
  proposalRkey: string;
  tally: RecordTally;
  recordOutcome: Outcome | null;
  cacheOutcome: Outcome | null;
  quorum: number;
}): Promise<void> {
  await auditLog('community.proposal.resolution.deferred', null, input.communityDid, {
    rkey: input.proposalRkey,
    quorum: input.quorum,
    recordOutcome: input.recordOutcome,
    cacheOutcome: input.cacheOutcome,
    countedFor: input.tally.votesFor.length,
    countedAgainst: input.tally.votesAgainst.length,
    uncountedVotes: input.tally.uncounted,
  });
}
