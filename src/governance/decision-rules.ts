/**
 * The governance rules, with no way to reach a database.
 *
 * Resolution (`proposal-resolution.ts`) applies these rules online, against
 * Postgres. Verification (`verify-decision.ts`) applies them offline, against a
 * CAR export and a file of DID documents. If the two applied *different* rules
 * a decision could be sound by one and unsound by the other, and the offline
 * verdict would mean nothing — so both import the rules from here, and nothing
 * here imports anything that touches the database, the network, or the clock.
 */

export const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
export const VOTE_COLLECTION = 'net.openfederation.governance.vote';
export const DECISION_COLLECTION = 'net.openfederation.governance.decision';
export const SETTINGS_COLLECTION = 'net.openfederation.community.settings';

/**
 * Quorum applied when a community's settings record names none. Mirrors the
 * `|| 3` in `voteOnProposal`; the verifier has to reach the same number or a
 * decision could be sound online and short offline.
 */
export const DEFAULT_QUORUM = 3;

/** Marker on proposals whose outcome is decided from vote records. */
export const EVIDENCE_MODEL_VOTE_RECORDS = 'vote-records';

/** Upper bound on the retained proposal CID lineage. */
export const MAX_CID_CHAIN = 500;

export type VoteChoice = 'for' | 'against';
export type Outcome = 'approved' | 'rejected';

export interface QuorumRule {
  model: string;
  threshold: number;
  rule: string;
}

export function proposalUri(communityDid: string, proposalRkey: string): string {
  return `at://${communityDid}/${PROPOSAL_COLLECTION}/${proposalRkey}`;
}

/** Proposals created before the vote-record model keep the old array mechanics. */
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
export function tallyEpoch(proposal: any): string | null {
  const amendments = Array.isArray(proposal?.amendments) ? proposal.amendments : [];
  const last = amendments[amendments.length - 1];
  const epoch = last?.amendedAt ?? proposal?.createdAt;
  return typeof epoch === 'string' ? epoch : null;
}

/** What a vote record has to point at to be countable for a given proposal. */
export interface VoteEligibility {
  /** `at://<community>/<proposal collection>/<rkey>` the vote must cite. */
  proposalUri: string;
  /** The proposal's CID lineage; the vote must cite a member. */
  knownCids: Set<string>;
  /** Votes with an earlier `createdAt` were cleared by an amendment. */
  epoch: string | null;
}

export type VoteEligibilityResult =
  | { countable: true; vote: VoteChoice; proposalCid: string; createdAt: string }
  | { countable: false; reason: string };

/**
 * Decide whether one `net.openfederation.governance.vote` record counts.
 *
 * The rejection reasons are the strings that end up in a decision record's
 * `uncountedVotes[].reason`, so they are part of the published evidence and
 * should not be renamed casually.
 */
export function checkVoteRecord(record: any, ctx: VoteEligibility): VoteEligibilityResult {
  const vote = record?.vote;
  if (vote !== 'for' && vote !== 'against') {
    return { countable: false, reason: 'invalid-vote-value' };
  }
  // The vote must point at this exact proposal record, not merely mention it.
  if (record?.proposal?.uri !== ctx.proposalUri || record?.proposalCollection !== PROPOSAL_COLLECTION) {
    return { countable: false, reason: 'proposal-uri-mismatch' };
  }
  // ...and at a state this proposal actually passed through.
  if (typeof record?.proposal?.cid !== 'string' || !ctx.knownCids.has(record.proposal.cid)) {
    return { countable: false, reason: 'unknown-proposal-cid' };
  }
  // Votes predating the latest amendment were cleared from the tally.
  const createdAt = typeof record?.createdAt === 'string' ? record.createdAt : '';
  if (ctx.epoch && createdAt < ctx.epoch) {
    return { countable: false, reason: 'stale-vote-record' };
  }
  return { countable: true, vote, proposalCid: record.proposal.cid, createdAt };
}

/**
 * One vote per voter, decided the same way everywhere: the earliest record
 * wins, with the rkey breaking ties so the result never depends on iteration
 * order.
 */
export function voteOrderKey(createdAt: string, rkey: string): string {
  return `${createdAt}|${rkey}`;
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
