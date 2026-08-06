/**
 * The contest window between a decision and its effect (#197).
 *
 * Before this, a proposal that reached quorum was applied in the same request
 * that resolved it: the community learned what had been decided and what had
 * been done to its data at the same instant, with no interval in which to say
 * no. That is the one part of the governance chain a member cannot check *in
 * time to matter*, however verifiable it is afterwards.
 *
 * So an approved proposal now resolves into `pending-application` and waits
 * `governanceConfig.timelockHours`. During the wait any member who could have
 * voted can publish a `net.openfederation.governance.objection` record in their
 * own repo; once `governanceConfig.objectionThreshold` countable objections
 * exist the application is held. Nothing sufficiently objected to applies.
 * Nothing unobjected-to fails to apply.
 *
 * This is the `did:plc` rotation-recovery idiom — publish, wait, allow contest —
 * applied to community governance rather than to key rotation, deliberately, so
 * the stack has one story about how a signed act is challenged rather than two.
 * The port is not symmetric with its model and the asymmetry matters: in
 * `did:plc` the contester is the account owner recovering their own identity,
 * whereas here the contester is one of N peers stopping something the other N-1
 * may have voted for. **A hold is permanent.** There is no expiry, no
 * re-review, and no re-vote — `objected` is terminal, and at the default
 * threshold of 1 that means any single eligible member holds any decision
 * indefinitely. `objectionThreshold` exists so a community can choose otherwise;
 * choosing is the community's, never this module's.
 *
 * **`pending-application` is not `resolutionDeferred`.** A deferred resolution
 * is a proposal that is still `open` because the vote records and the vote cache
 * disagree: nothing has been decided, no decision record exists, and more votes
 * can still arrive. A pending application is a proposal that *has* been decided
 * — the decision record is written and cites its evidence — and is waiting out
 * a window before the decided change touches the repo. Deferral is doubt about
 * the evidence; pendency is confidence in the evidence plus a right of reply.
 *
 * Time-based transitions are evaluated lazily, on access, exactly as proposal
 * expiry already is inside `voteOnProposal`. There is no scheduler: a window
 * that has elapsed is applied by the next interaction that touches the
 * community's proposals. The window is therefore a *floor* on the delay, never
 * a promise of the exact instant — which is the same guarantee `expiresAt`
 * already gives, and the only one a system without a clock daemon can honestly
 * make.
 */

import type { Keypair } from '@atproto/crypto';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query, withAdvisoryLock } from '../db/client.js';
import {
  OBJECTION_COLLECTION,
  PROPOSAL_COLLECTION,
  applyAtFrom,
  checkObjectionRecord,
  objectionThreshold,
  proposalUri,
  timelockHours,
} from './decision-rules.js';
import { putProposalRecord } from './proposal-resolution.js';
import { SETTINGS_COLLECTION, checkGovernanceSettings } from './settings-rules.js';

export {
  DEFAULT_OBJECTION_THRESHOLD,
  DEFAULT_TIMELOCK_HOURS,
  objectionThreshold,
  timelockHours,
} from './decision-rules.js';

/** The community's settings record, or `undefined` when it has none. */
export async function communitySettingsRecord(communityDid: string): Promise<any> {
  const result = await query<{ record: any }>(
    `SELECT record FROM records_index
     WHERE community_did = $1 AND collection = $2 AND rkey = 'self'`,
    [communityDid, SETTINGS_COLLECTION],
  );
  return result.rows[0]?.record;
}

/** Decided and applicable, but waiting out the contest window. */
export const PENDING_STATUS = 'pending-application';
/** Decided, contested within the window; the change is held. */
export const OBJECTED_STATUS = 'objected';

/** The advisory lock every writer of a single proposal's state contends on. */
export function proposalLockKey(communityDid: string, proposalRkey: string): string {
  return `community-proposal:${communityDid}:${proposalRkey}`;
}

export interface CountedObjection {
  objector: string;
  record: { uri: string; cid: string };
  createdAt: string;
  reason?: string;
}

/**
 * Every objection record that holds this proposal's application.
 *
 * Read from the objectors' own repos and re-checked against the same predicate
 * the submitting endpoint applied, so a hold rests on a signed record rather
 * than on the `objections` array the community repo caches. Late records, and
 * records naming some other decision, are simply not here.
 */
export async function countableObjections(input: {
  communityDid: string;
  proposalRkey: string;
  proposal: any;
}): Promise<CountedObjection[]> {
  const { communityDid, proposalRkey, proposal } = input;
  const decisionUri = proposal?.decision?.uri;
  const decisionCid = proposal?.decision?.cid;
  const resolvedAt = proposal?.resolvedAt;
  const applyAt = proposal?.applyAt;
  if (typeof decisionUri !== 'string' || typeof decisionCid !== 'string'
    || typeof resolvedAt !== 'string' || typeof applyAt !== 'string') {
    return [];
  }

  const rows = await query<{ repo_did: string; rkey: string; cid: string; record: any }>(
    `SELECT community_did AS repo_did, rkey, cid, record
     FROM records_index
     WHERE collection = $1
       AND record->>'community' = $2
       AND record->>'proposalRkey' = $3`,
    [OBJECTION_COLLECTION, communityDid, proposalRkey],
  );

  const ctx = {
    proposalUri: proposalUri(communityDid, proposalRkey),
    decisionUri,
    decisionCid,
    resolvedAt,
    applyAt,
  };

  /** One hold per objector; the earliest countable record is the one cited. */
  const held = new Map<string, CountedObjection>();
  for (const row of rows.rows) {
    const result = checkObjectionRecord(row.record ?? {}, ctx);
    if (!result.countable) continue;
    const existing = held.get(row.repo_did);
    if (existing && existing.createdAt <= result.createdAt) continue;
    held.set(row.repo_did, {
      objector: row.repo_did,
      record: { uri: `at://${row.repo_did}/${OBJECTION_COLLECTION}/${row.rkey}`, cid: row.cid },
      createdAt: result.createdAt,
      ...(typeof row.record?.reason === 'string' ? { reason: row.record.reason } : {}),
    });
  }
  return [...held.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The state an approved proposal enters on resolution.
 *
 * `null` means there is no window to wait out and the change applies in the
 * resolving request, as it always did — which only happens when the community's
 * settings record states `timelockHours: 0`.
 */
export function pendingApplicationState(settings: any, resolvedAt: string): { applyAt: string } | null {
  const hours = timelockHours(settings);
  if (hours <= 0) return null;
  return { applyAt: applyAtFrom(resolvedAt, hours) };
}

/** A passed proposal whose `proposedRecord` must not be written as it stands. */
export class UnapplicableProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnapplicableProposalError';
  }
}

/**
 * Perform the change a proposal proposed. The single place the effect of an
 * approved proposal is produced, so resolution and lazy application cannot
 * drift apart in what "applied" means.
 *
 * A proposal is applied verbatim, which is exactly right for a record whose
 * contents are the community's business — and exactly wrong for the one record
 * that decides how the community is governed at all. Since #198 made the
 * proposal route the *only* way to change `governanceModel` under a voting
 * model, an unvalidated apply would let a quorum enact `governanceModel:
 * 'simple_majority'` (a typo) and leave the community with a model nothing
 * recognizes. Validation happens at proposal creation, where the proposer sees
 * the error; this is the backstop for anything that reaches here anyway, and it
 * refuses rather than guesses.
 */
export async function proposalApplicationProblem(communityDid: string, proposal: any): Promise<string | null> {
  if (proposal?.action !== 'write' || !proposal?.proposedRecord) return null;
  if (proposal.targetCollection !== SETTINGS_COLLECTION) return null;
  const invalid = checkGovernanceSettings(await recordToWrite(communityDid, proposal));
  return invalid
    ? `refusing to apply a settings proposal that would leave this community ungoverned: ${invalid.message}`
    : null;
}

/**
 * The record a `write` proposal will actually put — which is not always the
 * record it proposed.
 *
 * A proposal used to be applied as a whole-record replace, which is right for a
 * record whose contents are the community's business and wrong for
 * `net.openfederation.community.settings`: a proposal carrying
 * `{governanceModel, governanceConfig}` would silently drop every other field
 * of the settings record — the joinPolicy, the visibility, the description —
 * because it did not mention them. Since #198 made the proposal route the
 * *only* way to change the governance model under a voting model, that is now
 * the mandatory route for the most consequential change a community can make.
 *
 * So a settings proposal is merged over the settings record as it stands at
 * apply time, rather than replacing it. Merging *here* rather than normalizing
 * the proposal at creation time is deliberate: the settings record is mutable
 * and can legitimately change during a proposal's life (another proposal, an
 * ungoverned field), and a record normalized at creation would silently revert
 * whatever moved in between — reintroducing the same whole-record replace one
 * step earlier. The proposal states the fields it changes; everything it does
 * not name is left alone. Nothing offline depends on this: `verifyDecision`
 * judges whether a decision is sound from the votes it cites and never reads
 * what the application wrote, so online and offline rules stay identical.
 *
 * `governanceConfig` merges a level deeper than the rest (#202). Replacing it
 * whole meant a proposal to change only `quorum` also reset `timelockHours` to
 * 24 and `objectionThreshold` to 1 — governance changes nobody voted for,
 * arriving as a side effect of the one that was. A decision should change
 * exactly what it proposed.
 *
 * To restore a key to its default, name it explicitly with that value; merging
 * means omission now reads as "leave it alone" rather than "reset it".
 */
export async function recordToWrite(communityDid: string, proposal: any): Promise<Record<string, unknown>> {
  if (proposal?.targetCollection !== SETTINGS_COLLECTION || proposal?.targetRkey !== 'self') {
    return proposal.proposedRecord;
  }
  const current = await communitySettingsRecord(communityDid);
  if (!current || typeof current !== 'object') return proposal.proposedRecord;

  const merged: Record<string, unknown> = { ...current, ...proposal.proposedRecord };

  const currentConfig = (current as Record<string, unknown>).governanceConfig;
  const proposedConfig = proposal.proposedRecord?.governanceConfig;
  if (isPlainObject(currentConfig) && isPlainObject(proposedConfig)) {
    merged.governanceConfig = { ...currentConfig, ...proposedConfig };
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function applyProposedChange(
  engine: RepoEngine,
  keypair: Keypair,
  proposal: any,
): Promise<void> {
  if (proposal?.action === 'write' && proposal?.proposedRecord) {
    const problem = await proposalApplicationProblem(engine.did, proposal);
    if (problem) throw new UnapplicableProposalError(problem);
    const record = await recordToWrite(engine.did, proposal);
    await engine.putRecord(keypair, proposal.targetCollection, proposal.targetRkey, record);
  } else if (proposal?.action === 'delete') {
    await engine.deleteRecord(keypair, proposal.targetCollection, proposal.targetRkey);
  }
}

export type ApplyOutcome =
  | { state: 'applied' }
  | { state: 'unapplicable'; reason: string }
  | { state: 'not-pending' }
  | { state: 'window-open'; applyAt: string }
  | { state: 'objected'; objections: CountedObjection[] };

/**
 * Apply one proposal whose contest window has elapsed, if it is due and
 * unobjected.
 *
 * Re-reads the proposal under the proposal's own advisory lock — the same lock
 * voting and objecting take — so this can be called from any read path without
 * racing a vote, an objection, or another lazy application.
 *
 * **The lock is taken only when there is plausibly work to do.** `getProposal`
 * is reachable unauthenticated on a public community and calls this on every
 * read, and `withAdvisoryLock` draws a connection from a pool half the size of
 * the main one and serializes behind any concurrent vote or objection on the
 * same proposal. So a single unlocked `SELECT` of the proposal's status and
 * `applyAt` runs first, and the overwhelmingly common no-op — a proposal that
 * is open, closed, held, or simply not yet due — returns from it. The check is
 * advisory only: everything it decides is decided again under the lock, so a
 * proposal that becomes due between the two reads is merely applied by the next
 * interaction, exactly as one that becomes due a millisecond later already is.
 */
export async function applyIfDue(input: {
  communityDid: string;
  proposalRkey: string;
  now?: Date;
}): Promise<ApplyOutcome> {
  const { communityDid, proposalRkey } = input;
  const now = input.now ?? new Date();

  const preview = await query<{ status: string | null; apply_at: string | null }>(
    `SELECT record->>'status' AS status, record->>'applyAt' AS apply_at
     FROM records_index
     WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, PROPOSAL_COLLECTION, proposalRkey],
  );
  const pending = preview.rows[0];
  if (!pending || pending.status !== PENDING_STATUS) return { state: 'not-pending' };
  if (!pending.apply_at) return { state: 'not-pending' };
  if (now.toISOString() < pending.apply_at) return { state: 'window-open', applyAt: pending.apply_at };

  return withAdvisoryLock(proposalLockKey(communityDid, proposalRkey), async () => {
    const result = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [communityDid, PROPOSAL_COLLECTION, proposalRkey],
    );
    const proposal = result.rows[0]?.record;
    if (!proposal || proposal.status !== PENDING_STATUS) return { state: 'not-pending' };

    const applyAt = typeof proposal.applyAt === 'string' ? proposal.applyAt : null;
    if (!applyAt || now.toISOString() < applyAt) {
      return applyAt ? { state: 'window-open', applyAt } : { state: 'not-pending' };
    }

    // The hold is decided from the signed objection records, not from the
    // proposal's `objections` cache — a crash between writing an objection
    // record and rewriting the proposal must not let the change through.
    const objections = await countableObjections({ communityDid, proposalRkey, proposal });
    const settings = await communitySettingsRecord(communityDid);
    const threshold = objectionThreshold(settings);
    if (objections.length >= threshold) {
      await putProposalRecord(new RepoEngine(communityDid), await getKeypairForDid(communityDid), communityDid, proposalRkey, {
        ...proposal,
        status: OBJECTED_STATUS,
        objections,
      });
      await auditLog('community.proposal.applicationHeld', null, communityDid, {
        rkey: proposalRkey,
        applyAt,
        objectionThreshold: threshold,
        objections: objections.map(o => ({ objector: o.objector, uri: o.record.uri, cid: o.record.cid })),
      });
      return { state: 'objected', objections };
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);

    // Whether the change can be made is decided *before* the status rewrite,
    // because that rewrite asserts `appliedAt`. Discovering the refusal
    // afterwards would leave a signed record claiming an application that never
    // happened, contradicted only by an audit row — and since #198 this refusal
    // is a deterministic, reachable case rather than a theoretical one. The
    // proposal still closes (the decision stands, and closing is what keeps the
    // change single-shot); it simply makes no claim to have been applied. The
    // immediate path in `voteOnProposal` reports the same thing the same way.
    const problem = await proposalApplicationProblem(communityDid, proposal);
    if (problem) {
      await putProposalRecord(engine, keypair, communityDid, proposalRkey, {
        ...proposal,
        status: 'approved',
      });
      await auditLog('community.proposal.applyFailed', null, communityDid, {
        rkey: proposalRkey,
        targetCollection: proposal.targetCollection,
        targetRkey: proposal.targetRkey,
        applyAt,
        reason: problem,
      });
      return { state: 'unapplicable', reason: problem };
    }

    // Status rewrite before the change, as at resolution: closing the proposal
    // first is what keeps the change single-shot, because a crash after this
    // point cannot re-enter a state that still says `pending-application`.
    await putProposalRecord(engine, keypair, communityDid, proposalRkey, {
      ...proposal,
      status: 'approved',
      appliedAt: now.toISOString(),
    });
    await applyProposedChange(engine, keypair, proposal);

    await auditLog('community.proposal.apply', null, communityDid, {
      rkey: proposalRkey,
      targetCollection: proposal.targetCollection,
      targetRkey: proposal.targetRkey,
      action: proposal.action,
      applyAt,
      timelocked: true,
      ...(proposal.decision ? { decisionUri: proposal.decision.uri, decisionCid: proposal.decision.cid } : {}),
    });
    return { state: 'applied' };
  });
}

/**
 * Apply every proposal in a community whose window has elapsed.
 *
 * This is the lazy evaluation hook: read and write paths that touch a
 * community's proposals call it first, so a due application lands on the next
 * interaction instead of waiting for a background job that does not exist.
 * Failures are contained rather than raised — a stuck proposal must not turn an
 * unrelated read into a 500, and the next interaction retries it.
 *
 * **Each proposal is isolated.** The sweep order is deterministic (`rkey ASC`)
 * and lazy evaluation is the only application mechanism, so a proposal that
 * throws — a missing keypair, an unwritable target collection, a repo error —
 * would otherwise abort the sweep at the same point on every subsequent call
 * and indefinitely block every later approved change in the community. So one
 * proposal failing skips that proposal only, and the failure is audited rather
 * than merely logged: a governance change that could not be applied is exactly
 * what the audit log is for.
 *
 * Must not be called while already holding a proposal's advisory lock: it takes
 * those locks itself, one at a time.
 */
export async function applyDueProposals(communityDid: string, now: Date = new Date()): Promise<number> {
  let applied = 0;
  let due;
  try {
    due = await query<{ rkey: string }>(
      `SELECT rkey FROM records_index
       WHERE community_did = $1 AND collection = $2
         AND record->>'status' = $3
         AND record->>'applyAt' <= $4
       ORDER BY rkey ASC`,
      [communityDid, PROPOSAL_COLLECTION, PENDING_STATUS, now.toISOString()],
    );
  } catch (error) {
    console.error(`[governance] timelock sweep could not list due proposals for ${communityDid}:`, error);
    return 0;
  }

  for (const row of due.rows) {
    const outcome = await applyIfDueSafely({ communityDid, proposalRkey: row.rkey, now });
    if (outcome?.state === 'applied') applied++;
  }
  return applied;
}

/**
 * `applyIfDue`, with the failure contained and recorded.
 *
 * The single containment point for a failing application, so the sweep and the
 * single-proposal read path (`getProposal`) treat a stuck proposal identically:
 * `null` back, the error logged, and an audit entry naming the proposal that
 * could not be applied.
 */
export async function applyIfDueSafely(input: {
  communityDid: string;
  proposalRkey: string;
  now?: Date;
}): Promise<ApplyOutcome | null> {
  try {
    return await applyIfDue(input);
  } catch (error) {
    console.error(`[governance] timelock application failed for ${input.communityDid}/${input.proposalRkey}:`, error);
    await auditLog('community.proposal.applyFailed', null, input.communityDid, {
      rkey: input.proposalRkey,
      reason: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    return null;
  }
}
