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
 *
 * An objection override round (#199) starts a new epoch for the same reason and
 * more urgently: the round exists to ask a *higher* bar, and counting the first
 * round's votes towards it would clear that bar with the mandate that was
 * already objected to. `overrideOpenedAt` is set after any amendment, so it
 * wins when both are present.
 */
export function tallyEpoch(proposal: any): string | null {
  if (typeof proposal?.overrideOpenedAt === 'string') return proposal.overrideOpenedAt;
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
 * The default is **1**: a single member holding `community.governance.write`
 * stops a change a majority voted for. That is deliberate — a contest window
 * whose threshold nobody has chosen should fail towards "wait and talk", not
 * towards "proceed anyway" — and it is survivable only because the hold is no
 * longer the end of the story. Until #199 it was: `objected` was terminal, so
 * one objector permanently converted majority rule into unanimity. The hold now
 * opens an override round (see below), so a lone objection forces a stronger
 * mandate rather than replacing it.
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

// ── The override round (#199) ───────────────────────────────────────
//
// PRD #189 specified "objection → application held pending re-review per
// community rules". The hold shipped; the re-review did not, and the gap was
// not cosmetic: `objected` was terminal, so at the default threshold of 1 any
// single member holding `community.governance.write` could permanently veto any
// decision of a majority-governed community. That is not a contest window, it
// is unanimity.
//
// A held proposal now opens one — and only one — override round. The same
// electorate votes again, against a higher bar than the one that was objected
// to, and the round is time-boxed. Three outcomes, all of them final:
//
//   reaches `overrideQuorum` votes for   the change applies
//   the round expires short of it        the proposal is rejected
//   the community disabled review        the hold stands, as it did before
//
// The asymmetry with the `did:plc` rotation-recovery idiom this whole mechanism
// mirrors is what forces the round to exist. In `did:plc` the contester is the
// account owner recovering their own identity, and a permanent veto is exactly
// right — nobody else has a claim. Here the contester is one of N peers
// overriding N−1, and the same permanence would hand any one of them a veto
// over all the others. The objection still carries real weight: it does not
// merely delay, it raises the bar the decision must clear.
//
// Only votes *for* count towards the override. The round asks "is there a
// stronger mandate than the one that was objected to?", and abstention and
// opposition answer that question the same way: no.

/** How a community treats a held proposal. */
export type ObjectionReview = 'override' | 'none';

/**
 * Days an override round stays open before the hold becomes final. A round that
 * nobody answers is a mandate nobody has, so expiry rejects rather than applies.
 */
export const DEFAULT_OBJECTION_OVERRIDE_DAYS = 7;

/**
 * What a community does with a held proposal.
 *
 * The default is `override`, so a community that has never thought about this
 * gets the re-review rather than the veto — which is the right way round,
 * because a community that has never thought about it is exactly the one that
 * will be surprised by a permanent hold. `none` restores the terminal `objected`
 * state for a community that deliberately wants an objection to be the end of
 * the matter. Anything unrecognized is the default: a typo must not silently
 * hand someone a veto.
 */
export function objectionReviewMode(settings: any): ObjectionReview {
  return settings?.governanceConfig?.objectionReview === 'none' ? 'none' : 'override';
}

export function objectionOverrideDays(settings: any): number {
  const configured = settings?.governanceConfig?.objectionOverrideDays;
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_OBJECTION_OVERRIDE_DAYS;
  }
  return configured;
}

/**
 * Votes *for* an override round must reach to carry the change.
 *
 * `governanceConfig.objectionOverrideQuorum` states it outright. Absent that it
 * is two-thirds of the electorate, floored at one more than the ordinary quorum
 * and capped at the electorate itself. All three parts are load-bearing:
 *
 *   two-thirds  the round must show a stronger mandate than a bare majority.
 *   quorum + 1  two-thirds of a small community can be *lower* than its quorum,
 *               and a bar below the original one would make an objection make a
 *               decision easier to pass.
 *   the cap     a community whose quorum already equals its electorate has
 *               nothing stronger than unanimity to ask for, and `quorum + 1`
 *               would be a bar no vote could ever clear — reinstating the
 *               permanent veto in exactly the small communities most exposed to
 *               it. Capped, the bar becomes unanimity: the strongest mandate
 *               that exists, and a reachable one.
 *
 * Never below 1, so an empty electorate cannot produce a round that carries on
 * no votes at all.
 *
 * `eligibleVoters` is the electorate counted when the round opens. It is frozen
 * onto the proposal record at that instant rather than recounted later: the
 * membership moves, and a bar that moved with it could be cleared by adding or
 * removing members mid-round rather than by winning the argument.
 */
export function overrideQuorumFrom(settings: any, quorum: number, eligibleVoters: number): number {
  const configured = settings?.governanceConfig?.objectionOverrideQuorum;
  if (typeof configured === 'number' && Number.isInteger(configured) && configured >= 1) {
    return configured;
  }
  const target = Math.max(quorum + 1, Math.ceil((eligibleVoters * 2) / 3));
  return Math.max(1, Math.min(target, eligibleVoters));
}

/** The instant an override round opened at `openedAt` stops accepting votes. */
export function overrideExpiresAt(openedAt: string, days: number): string {
  return new Date(new Date(openedAt).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Has an override round carried? `null` means "not yet" — the round stays open
 * until it does or until it expires.
 */
export function decideOverride(votesFor: number, overrideQuorum: number): Outcome | null {
  return votesFor >= overrideQuorum ? 'approved' : null;
}

export function quorumRule(model: string, threshold: number): QuorumRule {
  return {
    model,
    threshold,
    rule: `resolves once counted votes >= ${threshold}; approved when votes for exceed votes against`,
  };
}

/**
 * The permission a role must carry for its members to vote.
 *
 * Duplicated from `src/auth/permissions.ts` rather than imported: that module
 * reaches the database, and this one is the pure rule core the offline verifier
 * depends on. The string is the contract, and it is asserted equal to the auth
 * module's constant in the test suite so the two cannot drift apart.
 */
export const GOVERNANCE_WRITE_PERMISSION = 'community.governance.write';

/**
 * Permissions for a member record that names no `roleRkey`. Exported so the
 * governance eligibility evidence resolves permissions exactly the way the live
 * capability check does — two copies of this table would drift, and the whole
 * point of the evidence is that it reflects the rule actually applied.
 */
export const LEGACY_ROLE_PERMISSIONS: Record<string, string[]> = {
  // Owner holds every permission. Spelled out rather than imported from
  // `src/auth/permissions.ts` so this module stays free of the auth layer; the
  // test suite asserts this list equals ALL_PERMISSIONS so they cannot drift.
  owner: [
    'community.settings.write',
    'community.profile.write',
    'community.member.read',
    'community.member.write',
    'community.member.delete',
    'community.role.read',
    'community.role.write',
    'community.attestation.write',
    'community.attestation.delete',
    'community.application.write',
    'community.application.delete',
    'community.governance.write',
    'community.forum.write',
    'community.forum.moderate',
    'community.calendar.write',
  ],
  moderator: [
    'community.profile.write',
    'community.member.read',
    'community.member.write',
    'community.member.delete',
    'community.role.read',
    'community.attestation.write',
    'community.attestation.delete',
    'community.governance.write',
    'community.forum.write',
    'community.forum.moderate',
  ],
  member: ['community.member.read', 'community.role.read'],
};
