/**
 * Offline verification that a decided change was legitimately *applied* (#201).
 *
 * `verifyDecision` answers one question — was this decision soundly reached? —
 * and deliberately ignores objections, because an objection contests the
 * application, not the votes. That left the second half of the chain
 * unverifiable offline: a decision can be perfectly sound and still have been
 * applied a day early, or applied over a hold that should have stopped it.
 *
 * This is the sibling that answers the other question, under the same
 * constraints: no database, no network, no clock. Everything it needs is passed
 * in — the community's signed proposal record, signed exports for the community
 * and any objectors, and DID documents from a source the caller already trusts.
 * The predicates come from `decision-rules.ts` (`checkObjectionRecord`,
 * `objectionThreshold`), the same module the online path uses, so "this
 * objection held the change" cannot mean two different things.
 *
 * **What the timelock actually promises, and therefore what this can check.**
 * Application is lazy: there is no scheduler, and a proposal whose window has
 * elapsed is applied by the next interaction that touches it. The window is a
 * *floor* on the delay, never a promise of an exact instant. So an unapplied
 * proposal past its `applyAt` is `application-due` — a state, not a defect —
 * and only the inverse is provable dishonesty: a change applied *before* the
 * window it published closed, which no amount of laziness explains.
 *
 * **Time enters only where it must.** `asOf` is optional. Every clock-free
 * verdict renders without it — early application, a hold, an application over a
 * hold — because each is decided by comparing instants the records themselves
 * carry. Only the open/due distinction needs an external instant, and without
 * one this says so (`pending-application`) rather than inventing a now. A
 * verdict that silently depended on when it happened to be run would not be
 * reproducible, which is the property the whole exercise exists to have.
 *
 * **What it cannot decide, and says so rather than guessing.** Objector
 * *eligibility* is not re-derivable offline. A vote record carries the
 * community-signed member and role records consulted when it was cast (#200);
 * an objection record carries no equivalent, so entitlement was checked once,
 * online, at submission. This therefore counts objections that are structurally
 * and temporally countable and notes that the objectors' entitlement rests on
 * the community's word. The same asymmetry runs the other way: a hold this
 * cannot corroborate from the supplied exports is a note, never an accusation,
 * unless the objector's own repo is present and *contradicts* the hold.
 */

import {
  OBJECTION_COLLECTION,
  PROPOSAL_COLLECTION,
  SETTINGS_COLLECTION,
  checkObjectionRecord,
  objectionThreshold,
  proposalUri as buildProposalUri,
} from './decision-rules.js';
import {
  loadRepo,
  locateRecord,
  type CitedRecord,
  type DidDocumentLike,
  type LoadedRepo,
  type RepoProof,
  type VerificationProblem,
} from './verify-decision.js';

/**
 * A finding, in this module's own vocabulary.
 *
 * Deliberately not `VerificationProblem`: that type's codes are the decision
 * verifier's, and reusing them would let `insufficient-quorum` appear in an
 * application verdict where it can never be meaningful. The two codes the
 * shared repo loader can raise are named identically here, and translated on
 * the way in, so the strings a consumer filters on stay stable across both.
 */
export interface ApplicationProblem {
  code: ApplicationFailureCode;
  message: string;
  /** AT-URI of the record the finding concerns. */
  uri?: string;
  /** DID of the repo owner a repo-scoped finding concerns. */
  did?: string;
}

/** Decided and applicable, but waiting out the contest window. */
const PENDING_STATUS = 'pending-application';
/** Decided, contested within the window; the hold is final. */
const OBJECTED_STATUS = 'objected';
/** Held, and under re-review: the electorate is voting on a higher bar (#199). */
const OVERRIDE_STATUS = 'objection-override';

/**
 * The verdict codes, grouped by what they say about the operator.
 *
 * Legitimate — the signed records account for what happened:
 *   applied            the change was applied at or after the instant the
 *                      community published as its earliest applicable time.
 *   held               countable objections reached the threshold; the change
 *                      was withheld, which is the contest window working.
 *   nothing-to-apply   the proposal was rejected, expired, or is still open.
 *                      There is no application to judge.
 *
 * Pending — nothing has gone wrong and nothing has finished:
 *   window-open        `asOf` precedes `applyAt`; the contest window is running.
 *   application-due    the window has elapsed and the change has not been
 *                      applied. Application is lazy — the next interaction with
 *                      the proposal applies it — so this is expected, not late.
 *   pending-application  the proposal is awaiting application and no `asOf` was
 *                      supplied, so which of the two above it is was not
 *                      evaluated.
 *   override-round     the hold opened an override round and it is still
 *                      running (#199). Nothing has been applied and nothing has
 *                      been finally withheld.
 *   override-round-due the round's window has elapsed and the proposal has not
 *                      been closed yet. Closing is lazy, exactly as application
 *                      is, so this is a state rather than a defect.
 *
 * Indeterminate — the signed record genuinely does not distinguish:
 *   closed-unapplied   the proposal closed past its window without claiming an
 *                      application. The PDS writes exactly this when a passed
 *                      change is refused as unapplicable (see
 *                      `proposalApplicationProblem`), and nothing in the signed
 *                      record separates that refusal from a silent omission.
 *
 * Illegitimate — the records contradict the rules the community published:
 *   early-application     applied before its own `applyAt`. The contest window
 *                         did not close; whoever objected during the remainder
 *                         was objecting to something already done.
 *   applied-over-objection  applied although countable objections had reached
 *                         the threshold. The strongest finding here: a hold was
 *                         published in the objectors' own repos and overridden.
 *   unevidenced-hold      the proposal claims a hold and names its objectors,
 *                         but their own supplied repos do not contain countable
 *                         objections. A change withheld against the evidence.
 *   malformed-proposal    the record cannot be read as a proposal at all.
 *   missing-evidence      something needed was not supplied. Accuses nobody.
 *   forged-signature      an export's commit does not verify against its key.
 *   tampered-evidence     the proposal is not in the community's signed repo at
 *                         the CID it is cited under, or does not hash to it.
 */
export type ApplicationCode =
  | 'applied'
  | 'held'
  | 'nothing-to-apply'
  | 'window-open'
  | 'application-due'
  | 'pending-application'
  | 'override-round'
  | 'override-round-due'
  | 'closed-unapplied'
  | 'early-application'
  | 'applied-over-objection'
  | 'unevidenced-hold'
  | 'malformed-proposal'
  | 'missing-evidence'
  | 'forged-signature'
  | 'tampered-evidence';

export type ApplicationFailureCode = Extract<
  ApplicationCode,
  'early-application' | 'applied-over-objection' | 'unevidenced-hold'
  | 'malformed-proposal' | 'missing-evidence' | 'forged-signature' | 'tampered-evidence'
>;

/**
 * Codes that can appear on a note — an observation, never a reason to reject:
 *
 *   objector-eligibility-unverified  objections were counted structurally; that
 *                                    their authors held `community.governance.write`
 *                                    is the community's word, not evidence.
 *   hold-unverified                  the proposal claims a hold this could not
 *                                    corroborate because the objectors' repos
 *                                    were not supplied. Not a contradiction.
 *   settings-unavailable             the community's settings record was not in
 *                                    the export, so the objection threshold is
 *                                    the default rather than the community's.
 *   no-contest-window                the community configured `timelockHours: 0`,
 *                                    so the change applied in the resolving
 *                                    request and there was never a window.
 *   objection-count-drift            the proposal's cached `objections` array and
 *                                    the countable records disagree. The cache is
 *                                    not authoritative; the records are.
 */
export type ApplicationNoteCode =
  | 'objector-eligibility-unverified'
  | 'hold-unverified'
  | 'settings-unavailable'
  | 'no-contest-window'
  | 'objection-count-drift';

export interface ApplicationNote {
  code: ApplicationNoteCode;
  message: string;
  uri?: string;
}

/**
 * Reported worst-first, and `code` is the head of this list when anything
 * failed. Applying over a published hold outranks applying early: both break
 * the window, but one of them overrode signed records that said stop.
 */
const SEVERITY: ApplicationFailureCode[] = [
  'malformed-proposal',
  'forged-signature',
  'tampered-evidence',
  'applied-over-objection',
  'early-application',
  'unevidenced-hold',
  'missing-evidence',
];

/** One objection that holds, or would hold, this application. */
export interface CountedObjection {
  objector: string;
  uri: string;
  cid: string;
  createdAt: string;
}

export interface VerifyApplicationInput {
  /** The proposal whose application is in question, as cited. */
  proposal: CitedRecord;
  /** Signed exports: the community, plus any repo that may hold an objection. */
  repos: RepoProof[];
  /** DID documents from a caller-supplied source. Never resolved over the network. */
  didDocuments: DidDocumentLike[];
  /**
   * The instant to judge an unapplied proposal against. Omit to leave the
   * open/due distinction unevaluated rather than to read a clock.
   */
  asOf?: string;
}

export interface ApplicationVerdict {
  status: 'legitimate' | 'pending' | 'indeterminate' | 'illegitimate';
  code: ApplicationCode;
  problems: ApplicationProblem[];
  notes: ApplicationNote[];
  summary: {
    proposalUri: string;
    community: string | null;
    proposalRkey: string | null;
    /** `status` as the community's signed proposal record states it. */
    proposalStatus: string | null;
    resolvedAt: string | null;
    applyAt: string | null;
    appliedAt: string | null;
    decisionUri: string | null;
    /** Objections proved countable against the supplied exports. */
    countableObjections: number;
    /** How many the proposal's own cache claims. */
    cachedObjections: number;
    /** The threshold applied, and where it came from. */
    objectionThreshold: number;
    /** Set while an override round is running (#199). */
    overrideQuorum?: number | null;
    overrideExpiresAt?: string | null;
    thresholdFromSettings: boolean;
    objectors: CountedObjection[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseAtUri(uri: unknown): { repo: string; collection: string; rkey: string } | null {
  if (typeof uri !== 'string' || !uri.startsWith('at://')) return null;
  const parts = uri.slice('at://'.length).split('/');
  if (parts.length !== 3 || parts.some(p => p.length === 0)) return null;
  return { repo: parts[0], collection: parts[1], rkey: parts[2] };
}

/**
 * Was the change this proposal decided applied legitimately?
 *
 * Pure: no database, no network, no clock. Returns a verdict rather than
 * throwing — an unverifiable application is a result, not an exception.
 */
export async function verifyApplication(input: VerifyApplicationInput): Promise<ApplicationVerdict> {
  const problems: ApplicationProblem[] = [];
  const notes: ApplicationNote[] = [];

  const summary: ApplicationVerdict['summary'] = {
    proposalUri: input.proposal?.uri ?? '',
    community: null,
    proposalRkey: null,
    proposalStatus: null,
    resolvedAt: null,
    applyAt: null,
    appliedAt: null,
    decisionUri: null,
    countableObjections: 0,
    cachedObjections: 0,
    objectionThreshold: objectionThreshold(undefined),
    thresholdFromSettings: false,
    objectors: [],
  };

  /**
   * A failure always wins over a state: an early application is the verdict
   * even though the proposal also reads as applied.
   */
  const finish = (code: ApplicationCode, status: ApplicationVerdict['status']): ApplicationVerdict => {
    if (problems.length > 0) {
      const sorted = [...problems].sort((a, b) => SEVERITY.indexOf(a.code) - SEVERITY.indexOf(b.code));
      return { status: 'illegitimate', code: sorted[0].code, problems: sorted, notes, summary };
    }
    return { status, code, problems: [], notes, summary };
  };

  // ── Shape of the proposal ─────────────────────────────────────────
  const loc = parseAtUri(input.proposal?.uri);
  if (!loc || loc.collection !== PROPOSAL_COLLECTION) {
    problems.push({
      code: 'malformed-proposal',
      message: `proposal uri is not a ${PROPOSAL_COLLECTION} record uri`,
      uri: input.proposal?.uri,
    });
    return finish('malformed-proposal', 'illegitimate');
  }
  const community = loc.repo;
  summary.community = community;
  summary.proposalRkey = loc.rkey;

  // ── Signed exports ────────────────────────────────────────────────
  const didDocs = new Map<string, DidDocumentLike>();
  for (const doc of input.didDocuments ?? []) {
    if (doc && typeof doc.id === 'string') didDocs.set(doc.id, doc);
  }

  // The shared loader speaks the decision verifier's vocabulary; only two of
  // its codes are reachable here, and both name the same condition in this one.
  const loadProblems: VerificationProblem[] = [];
  const repos = new Map<string, LoadedRepo>();
  for (const proof of input.repos ?? []) {
    repos.set(proof.did, await loadRepo(proof, didDocs, loadProblems));
  }
  for (const problem of loadProblems) {
    problems.push({
      code: problem.code === 'forged-signature' ? 'forged-signature' : 'missing-evidence',
      message: problem.message,
      ...(problem.voter ? { did: problem.voter } : {}),
      ...(problem.uri ? { uri: problem.uri } : {}),
    });
  }

  const communityRepo = repos.get(community);
  if (!communityRepo) {
    problems.push({
      code: 'missing-evidence',
      message: `no repo export supplied for community ${community}`,
      did: community,
    });
    return finish('missing-evidence', 'illegitimate');
  }

  // ── The proposal is in the community's signed repo, unchanged ─────
  const inRepo = await locateRecord(communityRepo, PROPOSAL_COLLECTION, loc.rkey);
  if (!inRepo.found) {
    problems.push({ code: 'tampered-evidence', message: `proposal record: ${inRepo.reason}`, uri: input.proposal.uri });
    return finish('tampered-evidence', 'illegitimate');
  }
  if (inRepo.cid !== input.proposal.cid) {
    problems.push({
      code: 'tampered-evidence',
      message: `proposal is cited at ${input.proposal.cid} but the signed repo holds ${inRepo.cid}`,
      uri: input.proposal.uri,
    });
    return finish('tampered-evidence', 'illegitimate');
  }

  // Everything below reads the *repo's* copy, never the caller's. The two have
  // just been proved identical, so this changes no verdict — it removes the
  // question of which one a later reader is looking at.
  const proposal = inRepo.value;
  const status = str(proposal.status);
  const resolvedAt = str(proposal.resolvedAt);
  const applyAt = str(proposal.applyAt);
  const appliedAt = str(proposal.appliedAt);
  const decision = isRecord(proposal.decision) ? proposal.decision : null;
  const decisionUri = str(decision?.uri);
  const decisionCid = str(decision?.cid);
  const cached = Array.isArray(proposal.objections) ? proposal.objections : [];

  summary.proposalStatus = status;
  summary.resolvedAt = resolvedAt;
  summary.applyAt = applyAt;
  summary.appliedAt = appliedAt;
  summary.decisionUri = decisionUri;
  summary.cachedObjections = cached.length;

  // ── Nothing decided, nothing to judge ─────────────────────────────
  //
  // An open, expired or rejected proposal never produced a change. Saying
  // "legitimate" about it would overstate; saying "illegitimate" would be
  // false. It is simply not an application.
  if (status !== 'approved' && status !== PENDING_STATUS
    && status !== OBJECTED_STATUS && status !== OVERRIDE_STATUS) {
    return finish('nothing-to-apply', 'legitimate');
  }
  if (status === 'approved' && !applyAt && !appliedAt) {
    // Resolved under `timelockHours: 0`, or before the contest window existed:
    // the change was applied in the resolving request and there was no window
    // to wait out, so there is no timing claim to check.
    notes.push({
      code: 'no-contest-window',
      message: 'the proposal names no applyAt, so it applied in the request that resolved it; there was no contest window to check',
      uri: input.proposal.uri,
    });
    return finish('applied', 'legitimate');
  }

  // ── The objection threshold, from the community's own settings ────
  const settingsLoc = await locateRecord(communityRepo, SETTINGS_COLLECTION, 'self');
  if (settingsLoc.found) {
    summary.objectionThreshold = objectionThreshold(settingsLoc.value);
    summary.thresholdFromSettings = true;
  } else {
    notes.push({
      code: 'settings-unavailable',
      message: `the community's settings record is not in the export (${settingsLoc.reason}); `
        + `the default threshold of ${summary.objectionThreshold} is applied instead of the community's`,
      uri: `at://${community}/${SETTINGS_COLLECTION}/self`,
    });
  }

  // ── Objections, from the objectors' own signed repos ──────────────
  const objections = decisionUri && decisionCid && resolvedAt && applyAt
    ? await countObjections({
      repos,
      community,
      proposalRkey: loc.rkey,
      ctx: {
        proposalUri: buildProposalUri(community, loc.rkey),
        decisionUri,
        decisionCid,
        resolvedAt,
        applyAt,
      },
    })
    : [];
  summary.countableObjections = objections.length;
  summary.objectors = objections;

  if (objections.length > 0) {
    notes.push({
      code: 'objector-eligibility-unverified',
      message: `${objections.length} objection(s) are countable by the same predicate the online path applies, but an `
        + 'objection record carries no membership evidence; that its author held '
        + "community.governance.write rests on the community's word",
      uri: input.proposal.uri,
    });
  }
  if (cached.length !== objections.length) {
    notes.push({
      code: 'objection-count-drift',
      message: `the proposal caches ${cached.length} objection(s) and ${objections.length} are countable in the supplied `
        + 'exports; the cache is not authoritative and a missing objector export explains this as readily as a defect',
      uri: input.proposal.uri,
    });
  }

  const held = objections.length >= summary.objectionThreshold;

  // ── The verdict ───────────────────────────────────────────────────
  //
  // A hold and an override round rest on the same evidence — the objections
  // that produced them — so both are corroborated the same way. What differs is
  // only what happens next, and neither is an application.
  if (status === OVERRIDE_STATUS) {
    const unevidenced = holdContradiction(cached, repos, objections, held, input.proposal.uri);
    if (unevidenced) {
      problems.push(unevidenced);
      return finish('unevidenced-hold', 'illegitimate');
    }
    if (!held) notes.push(holdUnverifiedNote(objections.length, summary.objectionThreshold, input.proposal.uri));

    const expiresAt = str(proposal.overrideExpiresAt);
    summary.overrideExpiresAt = expiresAt;
    summary.overrideQuorum = typeof proposal.overrideQuorum === 'number' ? proposal.overrideQuorum : null;
    if (input.asOf && expiresAt && input.asOf >= expiresAt) {
      return finish('override-round-due', 'pending');
    }
    return finish('override-round', 'pending');
  }

  if (status === OBJECTED_STATUS) {
    if (held) return finish('held', 'legitimate');
    // The proposal claims a hold this could not corroborate. Whether that is a
    // withheld change or merely an export missing the objectors' repos turns on
    // one thing: whether those repos were supplied and contradict it.
    const unevidenced = holdContradiction(cached, repos, objections, held, input.proposal.uri);
    if (unevidenced) {
      problems.push(unevidenced);
      return finish('unevidenced-hold', 'illegitimate');
    }
    notes.push(holdUnverifiedNote(objections.length, summary.objectionThreshold, input.proposal.uri));
    return finish('held', 'legitimate');
  }

  if (appliedAt) {
    // The one thing laziness cannot explain: applying before the window the
    // community itself published as the earliest applicable instant.
    if (applyAt && appliedAt < applyAt) {
      problems.push({
        code: 'early-application',
        message: `the change was applied at ${appliedAt}, before the applyAt of ${applyAt} the proposal publishes; `
          + 'the contest window had not closed',
        uri: input.proposal.uri,
      });
      return finish('early-application', 'illegitimate');
    }
    if (held) {
      problems.push({
        code: 'applied-over-objection',
        message: `the change was applied at ${appliedAt} although ${objections.length} countable objection(s) had reached `
          + `the threshold of ${summary.objectionThreshold}; the hold was overridden`,
        uri: input.proposal.uri,
      });
      return finish('applied-over-objection', 'illegitimate');
    }
    return finish('applied', 'legitimate');
  }

  if (status === 'approved') {
    // Closed, past its window, claiming no application. This is what the PDS
    // writes when a passed change is refused as unapplicable — and it is also
    // what a silently skipped application would look like. The signed record
    // does not separate them, so neither does this.
    return finish('closed-unapplied', 'indeterminate');
  }

  // Still pending. Whether that is legitimate depends on an instant this
  // function will not invent.
  if (!input.asOf) return finish('pending-application', 'pending');
  if (applyAt && input.asOf < applyAt) return finish('window-open', 'pending');
  return finish('application-due', 'pending');
}

/**
 * Every objection record in the supplied exports that holds this application.
 *
 * Mirrors `countableObjections` in `timelock.ts` — one hold per objector, the
 * earliest countable record — but reads the objectors' signed repos instead of
 * `records_index`. Only a repo whose commit signature verified is counted: an
 * objection in an unverified export proves nothing about who wrote it.
 */
async function countObjections(input: {
  repos: Map<string, LoadedRepo>;
  community: string;
  proposalRkey: string;
  ctx: Parameters<typeof checkObjectionRecord>[1];
}): Promise<CountedObjection[]> {
  const held = new Map<string, CountedObjection>();

  for (const loaded of input.repos.values()) {
    if (!loaded.repo || !loaded.signatureVerified) continue;
    for await (const entry of loaded.repo.walkRecords()) {
      if (entry.collection !== OBJECTION_COLLECTION) continue;
      const record = entry.record as Record<string, unknown>;
      if (record?.community !== input.community || record?.proposalRkey !== input.proposalRkey) continue;

      const result = checkObjectionRecord(record, input.ctx);
      if (!result.countable) continue;

      const existing = held.get(loaded.did);
      if (existing && existing.createdAt <= result.createdAt) continue;
      held.set(loaded.did, {
        objector: loaded.did,
        uri: `at://${loaded.did}/${OBJECTION_COLLECTION}/${entry.rkey}`,
        cid: entry.cid.toString(),
        createdAt: result.createdAt,
      });
    }
  }

  return [...held.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The finding for a hold the objectors' own repos contradict, or `null` when
 * nothing contradicts it. Shared by the terminal hold and the override round,
 * which rest on identical evidence.
 */
function holdContradiction(
  cached: unknown[],
  repos: Map<string, LoadedRepo>,
  objections: CountedObjection[],
  held: boolean,
  uri: string,
): ApplicationProblem | null {
  if (held) return null;
  const contradicted = cachedObjectorsContradicted(cached, repos, objections);
  if (contradicted.length === 0) return null;
  return {
    code: 'unevidenced-hold',
    message: `the proposal is held on ${contradicted.length} objection(s) whose objectors' own signed repos contain `
      + `no countable objection: ${contradicted.join(', ')}`,
    uri,
  };
}

function holdUnverifiedNote(count: number, threshold: number, uri: string): ApplicationNote {
  return {
    code: 'hold-unverified',
    message: `the proposal is held but only ${count} countable objection(s) are provable from the supplied `
      + `exports against a threshold of ${threshold}; supply the objectors' repos to check the hold`,
    uri,
  };
}

/**
 * Cached objectors whose own supplied repo *contradicts* the hold.
 *
 * The distinction this draws is the whole point: an objector whose repo was
 * never supplied proves nothing either way, while an objector whose signed repo
 * is right here and contains no countable objection means the community is
 * withholding a change on evidence that does not exist.
 */
function cachedObjectorsContradicted(
  cached: unknown[],
  repos: Map<string, LoadedRepo>,
  countable: CountedObjection[],
): string[] {
  const proved = new Set(countable.map(o => o.objector));
  const contradicted: string[] = [];
  for (const entry of cached) {
    const objector = isRecord(entry) ? str(entry.objector) : null;
    if (!objector || proved.has(objector)) continue;
    const loaded = repos.get(objector);
    // Present, readable and signed — so its silence is evidence.
    if (loaded?.repo && loaded.signatureVerified) contradicted.push(objector);
  }
  return contradicted;
}
