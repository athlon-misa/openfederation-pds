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
export const OBJECTION_COLLECTION = 'net.openfederation.governance.objection';
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

// ── Timelock and objection window ───────────────────────────────────
//
// A decision settles what the votes said; it does not settle that the change
// should take effect immediately. An approved proposal enters
// `pending-application` for a contest window, during which an eligible member
// can publish a signed objection in their own repo. This deliberately mirrors
// the did:plc rotation-recovery idiom — publish, wait, allow contest — so the
// stack carries one trust vocabulary rather than two.
//
// These rules live here, alongside the vote rules, for the same reason those do:
// whatever checks an objection online and whatever rechecks it offline must
// apply the same predicate, or "this objection held the change" would mean two
// different things.

/**
 * Contest window applied when a community's settings record names none. A
 * community that genuinely wants instant application has to say `0` explicitly;
 * absence of the setting is not consent to it.
 */
export const DEFAULT_TIMELOCK_HOURS = 24;

/**
 * The contest window a community's settings record requires, in hours.
 *
 * `0` (application is immediate) is only produced when the config states it, so
 * a malformed or missing value can never silently shorten the window.
 */
export function timelockHours(settings: any): number {
  const configured = settings?.governanceConfig?.timelockHours;
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) {
    return DEFAULT_TIMELOCK_HOURS;
  }
  return configured;
}

/**
 * How many countable objections it takes to hold a decided change.
 *
 * The default is **1**, and that is a strong statement: a single member holding
 * `community.governance.write` can stop a change a majority voted for, and
 * nothing in this system reopens it. There is no expiry, no re-vote, no
 * override — a held proposal stays held. A community that does not want
 * unanimity-by-any-objector has to raise `governanceConfig.objectionThreshold`
 * deliberately, which is itself a governed change to the settings record.
 *
 * The default is 1 rather than something higher because a contest window whose
 * threshold nobody has chosen should fail towards "wait and talk", not towards
 * "proceed anyway" — but the cost of that default is stated here, in the
 * lexicon descriptions, and in the settings documentation, because a community
 * that discovers it only when a change is vetoed has been surprised by its own
 * governance.
 */
export const DEFAULT_OBJECTION_THRESHOLD = 1;

/**
 * The number of countable objections a community's settings record requires
 * before a decided change is held. A malformed or missing value is the default;
 * a *lower* bar can never be produced by accident.
 */
export function objectionThreshold(settings: any): number {
  const configured = settings?.governanceConfig?.objectionThreshold;
  if (typeof configured !== 'number' || !Number.isInteger(configured) || configured < 1) {
    return DEFAULT_OBJECTION_THRESHOLD;
  }
  return configured;
}

/** The instant a proposal resolved at `resolvedAt` becomes applicable. */
export function applyAtFrom(resolvedAt: string, hours: number): string {
  return new Date(new Date(resolvedAt).getTime() + hours * 60 * 60 * 1000).toISOString();
}

/** What an objection record has to point at to hold a pending application. */
export interface ObjectionEligibility {
  /** `at://<community>/<proposal collection>/<rkey>` the objection must cite. */
  proposalUri: string;
  /** AT-URI of the decision being contested. */
  decisionUri: string;
  /** CID of that decision record. */
  decisionCid: string;
  /** When the proposal resolved; an objection cannot predate what it contests. */
  resolvedAt: string;
  /** End of the contest window; an objection at or after it is late. */
  applyAt: string;
}

export type ObjectionEligibilityResult =
  | { countable: true; createdAt: string }
  | { countable: false; reason: string };

/**
 * Decide whether one `net.openfederation.governance.objection` record holds the
 * application of the decision it names.
 *
 * Structural and temporal only. Whether the objector is *eligible* is a
 * membership question, decided by the same community permission that gates
 * voting (`community.governance.write`) at the moment the objection is
 * submitted; it is not re-derivable from the record alone.
 *
 * The rejection reasons are recorded in the audit log and on the proposal, so
 * they are part of the published evidence and should not be renamed casually.
 */
export function checkObjectionRecord(record: any, ctx: ObjectionEligibility): ObjectionEligibilityResult {
  if (record?.proposal?.uri !== ctx.proposalUri || record?.proposalCollection !== PROPOSAL_COLLECTION) {
    return { countable: false, reason: 'proposal-uri-mismatch' };
  }
  // An objection contests one specific decision. Citing a different one — or an
  // earlier state of the same one — is not an objection to this application.
  if (record?.decision?.uri !== ctx.decisionUri || record?.decision?.cid !== ctx.decisionCid) {
    return { countable: false, reason: 'decision-mismatch' };
  }
  const createdAt = typeof record?.createdAt === 'string' ? record.createdAt : '';
  if (!createdAt || createdAt < ctx.resolvedAt) {
    return { countable: false, reason: 'objection-predates-decision' };
  }
  // The window is half-open: an objection written at or after the applicable
  // instant is late, whether or not anything has actually applied the change
  // yet. Lazy application must not turn a late objection into a timely one.
  if (createdAt >= ctx.applyAt) {
    return { countable: false, reason: 'late-objection' };
  }
  return { countable: true, createdAt };
}

export function quorumRule(model: string, threshold: number): QuorumRule {
  return {
    model,
    threshold,
    rule: `resolves once counted votes >= ${threshold}; approved when votes for exceed votes against`,
  };
}
