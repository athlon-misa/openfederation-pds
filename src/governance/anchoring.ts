/**
 * Anchoring: notarizing a decision that is already proved (#198).
 *
 * The `on-chain` governance model used to mean "the chain decides". It now
 * means what it should always have meant: **the community's repos decide, and a
 * chain may notarize what they already prove.** Resolution runs the same
 * hardened core path for every model — vote records in voters' own repos, a
 * signed decision record citing them, a contest window — and anchoring is the
 * optional step afterwards that publishes the decision's CID somewhere the PDS
 * cannot rewrite.
 *
 * That ordering is the whole point, so it is enforced structurally rather than
 * documented as an intention:
 *
 *   - Anchoring runs **after** the decision record, the proposal rewrite, the
 *     application, and their audit entries. There is no code path in which its
 *     result is read back into an outcome.
 *   - `anchorDecision` is **total**: it returns `null` instead of throwing, for
 *     every failure mode including a malformed receipt and a failed audit write.
 *   - A slow attestor is a failed attestor. `anchor()` races a timeout, so an
 *     attestor that never settles delays nothing beyond that bound and decides
 *     nothing at all.
 *
 * A failure is therefore never fatal, but it is never silent either: it is
 * logged and audited as `community.proposal.decision.anchorFailed`, and that
 * audit entry *is* the retry queue. The next resolution in the same community
 * re-reads the entries that have no matching success and tries them again
 * (`anchorPendingDecisions`). No scheduler, no new table, and no unbounded
 * backfill — only decisions this PDS actually attempted and failed to anchor
 * are ever retried. Retry is best-effort by construction: the queue is a bounded
 * read of recent failure entries, so an entry that falls out of that window is
 * not retried again. It is a way to recover from a notary that was briefly down,
 * not a delivery guarantee — and nothing depends on delivery.
 *
 * A community that has anchoring enabled with **no attestor registered at all**
 * is not treated as a failure: that is the state of every resolution on a PDS
 * without the chain module, so it is reported once per chain per process and
 * never audited or queued.
 *
 * **The receipt is recorded in the audit log, not on the decision record.**
 * What gets anchored is the decision's CID; writing the receipt back into that
 * record would change the very CID the receipt attests to, and would mutate a
 * signed piece of governance evidence after the fact. Keeping the receipt
 * beside the decision in the audit trail — where `decisionUri`, `decisionCid`
 * and `countedVoteCids` already live — leaves the signed evidence immutable and
 * keeps the notarization exactly what it claims to be: a statement *about* a
 * record, made from outside it.
 */

import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { resolveAttestor, type AnchorReceipt } from './attestor.js';

/** How long an attestor gets to settle before its anchor is treated as failed. */
const DEFAULT_ANCHOR_TIMEOUT_MS = 5_000;

/**
 * The bound on one anchor attempt, read per attempt rather than at import so an
 * operator (or a test) can set it without restarting the process. A notary that
 * has not answered inside it has failed, by definition: the alternative is a
 * resolved decision whose HTTP response waits on a third party.
 */
export function anchorTimeoutMs(): number {
  const configured = Number(process.env.GOVERNANCE_ANCHOR_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ANCHOR_TIMEOUT_MS;
}

/** Most stale anchor attempts retried on one resolution. */
const RETRY_BATCH = 5;

/** Most recent failure entries scanned when assembling the retry batch. */
const RETRY_SCAN = 50;

export interface AnchoringConfig {
  enabled: boolean;
  /** CAIP-2 chain ID the attestor is resolved under. Null when disabled. */
  chainId: string | null;
}

const DISABLED: AnchoringConfig = { enabled: false, chainId: null };

/**
 * Whether this community anchors its decisions, read from its signed settings
 * record.
 *
 * `governanceConfig.anchoring` is an ordinary setting in an ordinary protected
 * collection, so turning anchoring on or off is an ordinary governed settings
 * change — a proposal and a quorum wherever the community's model requires one.
 * There is no separate switch and no admin override; that is the whole of the
 * reframe.
 *
 * An explicit `anchoring` block always wins. Without one, `on-chain` anchors by
 * default (it is the tier's only remaining meaning) and every other model does
 * not.
 */
export function anchoringConfig(settings: any): AnchoringConfig {
  const config = settings?.governanceConfig;
  const anchoring = config?.anchoring;
  const fallbackChain = typeof config?.chainId === 'string' ? config.chainId : null;

  if (anchoring && typeof anchoring === 'object') {
    if (anchoring.enabled !== true) return DISABLED;
    const chainId = typeof anchoring.chainId === 'string' ? anchoring.chainId : fallbackChain;
    return chainId ? { enabled: true, chainId } : DISABLED;
  }

  if (settings?.governanceModel === 'on-chain' && fallbackChain) {
    return { enabled: true, chainId: fallbackChain };
  }
  return DISABLED;
}

/** A receipt is only a receipt if it says what was anchored. */
function readReceipt(value: unknown, chainId: string): AnchorReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const receipt = value as Partial<AnchorReceipt>;
  if (typeof receipt.anchoredCid !== 'string' || receipt.anchoredCid.length === 0) return null;
  return {
    chainId: typeof receipt.chainId === 'string' ? receipt.chainId : chainId,
    anchoredCid: receipt.anchoredCid,
    ...(typeof receipt.transactionHash === 'string' ? { transactionHash: receipt.transactionHash } : {}),
    ...(typeof receipt.timestamp === 'number' ? { timestamp: receipt.timestamp } : {}),
  };
}

/** Reject rather than hang: an attestor that never settles has failed. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`attestor did not respond within ${ms}ms`)), ms);
    work.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Chains this process has already reported as having no registered attestor. */
const announced = new Set<string>();

interface AnchorTarget {
  communityDid: string;
  proposalRkey: string | null;
  decisionUri: string;
  decisionCid: string;
}

/**
 * One anchor attempt. Never throws, never returns anything a caller could
 * mistake for permission to proceed — only the receipt, or `null`.
 */
async function attempt(target: AnchorTarget, chainId: string): Promise<AnchorReceipt | null> {
  const meta = {
    ...(target.proposalRkey ? { rkey: target.proposalRkey } : {}),
    decisionUri: target.decisionUri,
    decisionCid: target.decisionCid,
    chainId,
  };

  try {
    const attestor = resolveAttestor(chainId);
    if (!attestor || typeof attestor.anchor !== 'function') {
      // No attestor registered is a fact about this deployment, not a failure of
      // an available notary: on a PDS without the chain module it is true of
      // every resolution, forever. Auditing it per decision would fill the audit
      // trail of the default (module-disabled) deployment with rows that say
      // only "anchoring is not installed here", and would queue retries that can
      // never succeed until it is. Said once per chain per process, and nowhere
      // else.
      if (!announced.has(chainId)) {
        announced.add(chainId);
        console.warn(
          `[governance] community ${target.communityDid} has anchoring enabled for ${chainId}, ` +
          'but no attestor with anchor() is registered; decisions will resolve unanchored.',
        );
      }
      return null;
    }

    const raw = await withTimeout(
      Promise.resolve().then(() => attestor.anchor!(target.decisionCid)),
      anchorTimeoutMs(),
    );
    const receipt = readReceipt(raw, chainId);
    if (!receipt) {
      await auditLog('community.proposal.decision.anchorFailed', null, target.communityDid, {
        ...meta,
        reason: 'attestor returned no usable receipt (missing anchoredCid)',
      });
      return null;
    }

    await auditLog('community.proposal.decision.anchored', null, target.communityDid, {
      ...meta,
      chainId: receipt.chainId,
      anchoredCid: receipt.anchoredCid,
      ...(receipt.transactionHash ? { transactionHash: receipt.transactionHash } : {}),
      ...(receipt.timestamp !== undefined ? { timestamp: receipt.timestamp } : {}),
    });
    return receipt;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[governance] anchoring failed for ${target.decisionUri}:`, error);
    try {
      await auditLog('community.proposal.decision.anchorFailed', null, target.communityDid, { ...meta, reason });
    } catch {
      // An audit write that fails is still not a reason to disturb a decision
      // that has already been made and applied.
    }
    return null;
  }
}

/**
 * Anchor a freshly written decision, if this community anchors at all.
 *
 * Returns the receipt on success and `null` on every other path — disabled,
 * no attestor, attestor threw, attestor timed out, receipt unusable. Callers
 * are expected to ignore the return value except for reporting.
 */
export async function anchorDecision(input: {
  communityDid: string;
  proposalRkey: string;
  decision: { uri: string; cid: string };
  settings: any;
}): Promise<AnchorReceipt | null> {
  const config = anchoringConfig(input.settings);
  if (!config.enabled || !config.chainId) return null;
  return attempt(
    {
      communityDid: input.communityDid,
      proposalRkey: input.proposalRkey,
      decisionUri: input.decision.uri,
      decisionCid: input.decision.cid,
    },
    config.chainId,
  );
}

/**
 * Retry the anchors this community attempted and failed.
 *
 * The queue is derived, not stored: the recent `anchorFailed` entries minus the
 * ones that have since succeeded. A decision resolved while anchoring was off
 * was never attempted and so is never retried — enabling anchoring notarizes
 * the community's future, not its past.
 */
export async function anchorPendingDecisions(input: {
  communityDid: string;
  settings: any;
  limit?: number;
}): Promise<number> {
  const config = anchoringConfig(input.settings);
  if (!config.enabled || !config.chainId) return 0;
  const limit = input.limit ?? RETRY_BATCH;

  let pending: AnchorTarget[];
  try {
    const failures = await query<{ meta: any }>(
      `SELECT meta FROM audit_log
       WHERE action = 'community.proposal.decision.anchorFailed' AND target_id = $1
       ORDER BY id DESC LIMIT $2`,
      [input.communityDid, RETRY_SCAN],
    );
    const candidates = failures.rows
      .map(r => (typeof r.meta?.decisionCid === 'string' ? r.meta.decisionCid : null))
      .filter((c): c is string => Boolean(c));
    if (candidates.length === 0) return 0;

    const anchored = await query<{ cid: string }>(
      `SELECT meta->>'decisionCid' AS cid FROM audit_log
       WHERE action = 'community.proposal.decision.anchored' AND target_id = $1
         AND meta->>'decisionCid' = ANY($2)`,
      [input.communityDid, candidates],
    );
    const done = new Set(anchored.rows.map(r => r.cid).filter(Boolean));

    const seen = new Set<string>();
    pending = [];
    for (const row of failures.rows) {
      const decisionCid = typeof row.meta?.decisionCid === 'string' ? row.meta.decisionCid : null;
      const decisionUri = typeof row.meta?.decisionUri === 'string' ? row.meta.decisionUri : null;
      if (!decisionCid || !decisionUri || done.has(decisionCid) || seen.has(decisionCid)) continue;
      seen.add(decisionCid);
      pending.push({
        communityDid: input.communityDid,
        proposalRkey: typeof row.meta?.rkey === 'string' ? row.meta.rkey : null,
        decisionUri,
        decisionCid,
      });
      if (pending.length >= limit) break;
    }
  } catch (error) {
    console.error(`[governance] could not list pending anchors for ${input.communityDid}:`, error);
    return 0;
  }

  // Oldest attempt first, so a retry queue drains rather than churns.
  pending.reverse();

  // Stop at the first failure, and in any case at the budget. A notary that has
  // just failed will almost certainly fail for the rest of the batch too, and
  // each of those attempts costs a timeout inside somebody's resolution request;
  // one that answers slowly would otherwise multiply its latency by the batch
  // size. The queue keeps its place either way — the next resolution picks it
  // up — so the whole drain is bounded by a single attempt's timeout.
  const deadline = Date.now() + anchorTimeoutMs();
  let anchored = 0;
  for (const target of pending) {
    if (Date.now() >= deadline) break;
    if (!await attempt(target, config.chainId)) break;
    anchored++;
  }
  return anchored;
}
