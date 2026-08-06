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
import {
  DECISION_COLLECTION,
  EVIDENCE_MODEL_VOTE_RECORDS,
  MAX_CID_CHAIN,
  checkVoteRecord,
  decideOutcome,
  knownProposalCids,
  proposalUri,
  quorumRule,
  tallyEpoch,
  usesVoteRecordEvidence,
  voteOrderKey,
  type Outcome,
  type QuorumRule,
  type VoteChoice,
} from './decision-rules.js';

// The rules themselves live in `decision-rules.ts` so the offline verifier can
// apply exactly the same ones without reaching a database. Re-exported here
// because this module has always been their public entry point.
export {
  DECISION_COLLECTION,
  EVIDENCE_MODEL_VOTE_RECORDS,
  decideOutcome,
  knownProposalCids,
  proposalUri,
  quorumRule,
  usesVoteRecordEvidence,
};
export type { Outcome, QuorumRule, VoteChoice };

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
    // Ordered so the scan itself is reproducible. The tally does not depend on
    // it -- the earliest-record rule and the sort below both order explicitly --
    // but an unordered scan makes two identical runs differ in the intermediate
    // state, which is needless variance in something meant to be replayable.
    `SELECT community_did AS repo_did, rkey, cid, record
     FROM records_index
     WHERE collection = $1
       AND record->>'community' = $2
       AND record->>'proposalRkey' = $3
     ORDER BY community_did, rkey`,
    [VOTE_COLLECTION, communityDid, proposalRkey],
  );

  /** voter DID -> the record that counts for them, plus why others didn't. */
  const counted = new Map<string, CountedVote>();
  const rejected = new Map<string, string>();
  const orderKey = new Map<string, string>();

  for (const row of rows.rows) {
    const record = row.record ?? {};
    const voter = row.repo_did;

    // Exactly the predicate the offline verifier re-runs on the same record.
    const eligibility = checkVoteRecord(record, { proposalUri: uri, knownCids, epoch });
    if (!eligibility.countable) {
      if (!counted.has(voter) && !rejected.has(voter)) rejected.set(voter, eligibility.reason);
      continue;
    }

    // One vote per voter: earliest record wins, deterministically.
    const key = voteOrderKey(eligibility.createdAt, row.rkey);
    const previous = orderKey.get(voter);
    if (previous !== undefined && previous <= key) continue;

    orderKey.set(voter, key);
    rejected.delete(voter);
    counted.set(voter, {
      voter,
      vote: eligibility.vote,
      record: { uri: `at://${voter}/${VOTE_COLLECTION}/${row.rkey}`, cid: row.cid },
      proposalCid: eligibility.proposalCid,
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

  // Order deterministically before the decision record is built (#204).
  //
  // A Map yields insertion order, which here follows an unordered SQL result,
  // so two resolutions of identical evidence could emit `votes` in different
  // orders — different record content, therefore a different CID for the same
  // decision. Everything downstream compares CID *sets* and so never noticed,
  // but it meant two PDSes replaying one history could not produce the same
  // record, and every test comparing decisions had to normalise first.
  //
  // `voteOrderKey` is the same ordering the one-vote-per-voter rule already
  // uses — earliest `createdAt`, ties broken by rkey — so this introduces no
  // new notion of order, it just applies the existing one to the output.
  const votes = [...counted.values()].sort((a, b) => {
    const ka = orderKey.get(a.voter) ?? '';
    const kb = orderKey.get(b.voter) ?? '';
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.voter < b.voter ? -1 : a.voter > b.voter ? 1 : 0;
  });
  return {
    // `filter` preserves order, so each side stays chronological.
    votesFor: votes.filter(v => v.vote === 'for'),
    votesAgainst: votes.filter(v => v.vote === 'against'),
    uncounted,
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

/**
 * The vote record CIDs a decision cites — the evidence it actually rests on,
 * read from the same field the offline verifier reads (`votes[].record.cid`).
 */
function citedVoteCids(record: any): Set<string> {
  const votes = Array.isArray(record?.votes) ? record.votes : [];
  const cids = new Set<string>();
  for (const vote of votes) {
    const cid = vote?.record?.cid;
    if (typeof cid === 'string') cids.add(cid);
  }
  return cids;
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
 *
 * The reuse is only safe while the existing decision still cites *the same
 * evidence*. Matching outcomes are not enough. After a crash the tally can
 * legitimately have moved on — the crashed voter's vote record is committed
 * even though the cache rewrite never happened — and the next vote can then
 * produce the same outcome from a strictly larger set of votes. Reusing the
 * decision there closes the proposal citing a record that counts N votes while
 * N+1 eligible vote records exist, which is precisely the shape
 * `verifyDecision` reports as `uncounted-vote` → `invalid`, with no
 * supersession to excuse it and no repair path: the community's only decision
 * record for a change that really was applied would be permanently
 * unverifiable.
 *
 * So reuse requires both the outcome and the counted vote CID set to match. Any
 * difference — a different outcome, an extra vote, a vote that stopped counting
 * — writes a fresh decision that supersedes the stale one, which is the case
 * the verifier already knows how to excuse, and audits why.
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

  // Latest first: decisions can form a supersession chain.
  const existing = await query<{ rkey: string; cid: string; record: any }>(
    `SELECT rkey, cid, record FROM records_index
     WHERE community_did = $1 AND collection = $2 AND record->>'proposalRkey' = $3
     ORDER BY rkey DESC LIMIT 1`,
    [communityDid, DECISION_COLLECTION, proposalRkey],
  );

  const votes = [...tally.votesFor, ...tally.votesAgainst];
  const countedCids = new Set(votes.map(v => v.record.cid));

  let supersedes: { uri: string; cid: string } | undefined;
  if (existing.rows.length > 0) {
    const { rkey, cid, record } = existing.rows[0];
    const uri = `at://${communityDid}/${DECISION_COLLECTION}/${rkey}`;
    const citedCids = citedVoteCids(record);
    const sameEvidence = citedCids.size === countedCids.size
      && [...countedCids].every(c => citedCids.has(c));
    if (record?.proposalRkey === proposalRkey && record?.outcome === outcome && sameEvidence) {
      return { uri, cid, rkey };
    }
    supersedes = { uri, cid };
    await auditLog('community.proposal.decision.superseded', null, communityDid, {
      rkey: proposalRkey,
      supersededUri: uri,
      supersededCid: cid,
      previousOutcome: record?.outcome ?? null,
      outcome,
      // Which of the two reasons applies matters when reading this back: an
      // outcome flip is a governance event, an evidence change is a crash the
      // retry repaired.
      reason: record?.outcome !== outcome ? 'outcome-changed' : 'evidence-changed',
      previousVoteCids: [...citedCids],
      countedVoteCids: [...countedCids],
    });
  }

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
    ...(supersedes ? { supersedes } : {}),
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
