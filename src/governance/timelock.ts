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
 * own repo; one countable objection holds the application. Nothing objected to
 * applies. Nothing unobjected-to fails to apply.
 *
 * This is the `did:plc` rotation-recovery idiom — publish, wait, allow contest —
 * applied to community governance rather than to key rotation, deliberately, so
 * the stack has one story about how a signed act is challenged rather than two.
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
  proposalUri,
  timelockHours,
} from './decision-rules.js';
import { putProposalRecord } from './proposal-resolution.js';

export { DEFAULT_TIMELOCK_HOURS, timelockHours } from './decision-rules.js';

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

/**
 * Perform the change a proposal proposed. The single place the effect of an
 * approved proposal is produced, so resolution and lazy application cannot
 * drift apart in what "applied" means.
 */
export async function applyProposedChange(
  engine: RepoEngine,
  keypair: Keypair,
  proposal: any,
): Promise<void> {
  if (proposal?.action === 'write' && proposal?.proposedRecord) {
    await engine.putRecord(keypair, proposal.targetCollection, proposal.targetRkey, proposal.proposedRecord);
  } else if (proposal?.action === 'delete') {
    await engine.deleteRecord(keypair, proposal.targetCollection, proposal.targetRkey);
  }
}

export type ApplyOutcome =
  | { state: 'applied' }
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
 */
export async function applyIfDue(input: {
  communityDid: string;
  proposalRkey: string;
  now?: Date;
}): Promise<ApplyOutcome> {
  const { communityDid, proposalRkey } = input;
  const now = input.now ?? new Date();

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
    if (objections.length > 0) {
      await putProposalRecord(new RepoEngine(communityDid), await getKeypairForDid(communityDid), communityDid, proposalRkey, {
        ...proposal,
        status: OBJECTED_STATUS,
        objections,
      });
      await auditLog('community.proposal.applicationHeld', null, communityDid, {
        rkey: proposalRkey,
        applyAt,
        objections: objections.map(o => ({ objector: o.objector, uri: o.record.uri, cid: o.record.cid })),
      });
      return { state: 'objected', objections };
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);

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
 * Failures are logged and swallowed — a stuck proposal must not turn an
 * unrelated read into a 500, and the next interaction retries it.
 *
 * Must not be called while already holding a proposal's advisory lock: it takes
 * those locks itself, one at a time.
 */
export async function applyDueProposals(communityDid: string, now: Date = new Date()): Promise<number> {
  let applied = 0;
  try {
    const due = await query<{ rkey: string }>(
      `SELECT rkey FROM records_index
       WHERE community_did = $1 AND collection = $2
         AND record->>'status' = $3
         AND record->>'applyAt' <= $4
       ORDER BY rkey ASC`,
      [communityDid, PROPOSAL_COLLECTION, PENDING_STATUS, now.toISOString()],
    );
    for (const row of due.rows) {
      const outcome = await applyIfDue({ communityDid, proposalRkey: row.rkey, now });
      if (outcome.state === 'applied') applied++;
    }
  } catch (error) {
    console.error(`[governance] timelock sweep failed for ${communityDid}:`, error);
  }
  return applied;
}
