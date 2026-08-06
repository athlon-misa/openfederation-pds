/**
 * Offline verification of a governance decision (#196).
 *
 * The point of the whole evidence chain is that a third party can recheck a
 * community's decision **without asking the PDS that hosted it anything**. That
 * is only true if the check itself needs nothing from that PDS at runtime — so
 * `verifyDecision` reads no database, opens no socket, and resolves no DID over
 * the network. Everything it needs is passed in: the decision record, the
 * proposal it cites, signed repo exports for the community and every voter, and
 * the voters' DID documents from a source the verifier already trusts.
 *
 * **What that does and does not buy — stated precisely, because the difference
 * is the whole value of the exercise.**
 *
 *   - *Not* "without trusting the PDS." This PDS holds the signing keys of the
 *     accounts it hosts (`user_signing_keys`, `getKeypairForDid`), so a
 *     voter-signed vote record from a locally-hosted account is still something
 *     the operator can produce. A dishonest operator does not fail these checks;
 *     it forges a coherent history that passes them.
 *   - What is bought instead is **tamper-evidence and public consistency**. To
 *     forge, the operator must forge *coherently* — every cited vote in the
 *     right voter's repo, under the right MST, inside a commit chain that third
 *     parties can fetch now and diff against what they fetched before — and
 *     must do it *in the open*, because the forgery lives in published repos
 *     rather than in a private database. Retroactive edits become detectable,
 *     selective disclosure becomes detectable, and a decision stops being an
 *     unfalsifiable assertion. That is real and it is what a self-hosted or
 *     externally-hosted voter's repo converts into full independence: a vote
 *     record in a repo this PDS does not hold the keys for cannot be forged by
 *     this PDS at all.
 *   - **Voter eligibility is not checked, at all.** Neither
 *     `tallyFromVoteRecords` (online) nor this function (offline) verifies that
 *     a counted DID was a member of the community holding
 *     `community.governance.write` at the time it voted. A decision citing five
 *     authentic, well-formed votes from five DIDs that were never members
 *     verifies as `valid` here. The comment below records this for objections;
 *     it applies identically to votes, and silently. Closing it needs the
 *     decision record to cite the member-list record CID it counted against, so
 *     that membership becomes evidence rather than an assumption — a follow-up,
 *     deliberately not smuggled in as a behaviour change here.
 *
 * What is actually proved, and in what order:
 *
 *   1. Each repo export carries a commit signed by its owner's atproto key, and
 *      the commit names the same DID as the export claims. Records are then
 *      located by walking the MST from that commit, so a record is only ever
 *      "in" a repo if the signature covers it.
 *   2. The decision and the proposal are in the community's signed repo at the
 *      CIDs they are cited by, and their content hashes to those CIDs.
 *   3. Every vote the decision counted is in that voter's own signed repo, at
 *      the cited CID, saying what the decision says it says.
 *   4. Those votes were eligible under the same rules resolution applied
 *      (`decision-rules.ts` — imported by both, never re-implemented here).
 *   5. No eligible vote present in the provided exports was left out, and the
 *      published tally matches the votes it cites.
 *   6. The tally clears the quorum the *community's* signed settings record
 *      requires — not merely the threshold the decision publishes about itself,
 *      which an adversary would simply set low — and the outcome is what that
 *      rule produces.
 *
 * Nothing a caller asserts is taken on trust. In particular a superseding
 * decision must itself be found in the community's signed repo at the CID it is
 * offered under, because honouring it excuses the very failure this function
 * exists to raise.
 *
 * Three states that look like corruption but are not, and are handled as such:
 *
 *   - **Superseded decisions.** A crash between the decision write and the
 *     proposal status rewrite leaves an earlier decision that a later one
 *     replaces via `supersedes`. The earlier one is legitimately stale: newer
 *     votes exist that it does not cite. Pass the sibling decisions in and, if
 *     one of them really is in the community's signed repo and really does
 *     supersede this decision, the verdict is `superseded` with the staleness
 *     demoted to a note.
 *   - **Orphan decisions.** A crash with no subsequent vote leaves a decision
 *     for a proposal that later expired. Nothing about its evidence is wrong,
 *     so this function deliberately never looks at the proposal's `status`.
 *   - **`evidenceComplete: false`.** Cache votes that produced no countable
 *     record are enumerated in `uncountedVotes`; that is a disclosed gap, not a
 *     failure. It is reported as a note.
 *
 * **Objections (#197) do not enter this verdict, deliberately.** A
 * `net.openfederation.governance.objection` contests the *application* of a
 * decision inside its timelock window; it says nothing about whether the votes
 * the decision cites were real, eligible, complete, or correctly counted, which
 * is the only question asked here. Treating an objection as a defect would make
 * a sound decision verify as unsound because someone disagreed with it — the
 * opposite of what a contest window is for. The two questions are separable and
 * are kept separate: "is this decision sound?" is answered here; "was the
 * change legitimately applied?" is answered from the community's signed
 * proposal record (`status`, `applyAt`, `objections`) and the objectors' signed
 * objection records, under `checkObjectionRecord` — the same predicate the
 * online path applies, and for the same reason the vote rules are shared.
 * `verifyDecision` still never reads the proposal's `status`.
 *
 * **Anchor receipts (#198) do not enter this verdict either, and deliberately
 * do not appear in the decision record at all.** When a community anchors, a
 * registered attestor notarizes the decision's CID and the receipt is written
 * to the audit log (`src/governance/anchoring.ts`). Nothing here reads it, for
 * three reasons that all say the same thing:
 *
 *   - Checking a receipt means reading a chain. This function reads no network,
 *     by construction, because a verdict that needs a live external service is
 *     not an offline verdict.
 *   - A missing or failed anchor would then become a defect, which would make a
 *     decision's soundness depend on a notary's availability — the exact
 *     inversion (chain as authority rather than witness) this whole refactor
 *     removes. Anchoring can only ever add evidence; it can never subtract any.
 *   - The anchored CID *is* the decision's CID, so a receipt proves only that
 *     the record this function already verifies existed at some time. Whether
 *     that record is sound is answered here, from signatures alone, with or
 *     without a notary — and a caller holding a receipt can compare its
 *     `anchoredCid` against `summary.decisionUri`'s CID without any help.
 *
 * An anchor is therefore a strictly additive, independently checkable claim
 * about a decision, verified (if at all) by whoever trusts that chain, against
 * the same CID this function reports on.
 */

import { CID } from 'multiformats/cid';
import {
  BlockMap,
  MemoryBlockstore,
  Repo,
  cborToLexRecord,
  cidForRecord,
  formatDataKey,
  verifyCommitSig,
} from '@atproto/repo';
import { getKey } from '@atproto/identity';
import {
  DECISION_COLLECTION,
  DEFAULT_QUORUM,
  PROPOSAL_COLLECTION,
  SETTINGS_COLLECTION,
  VOTE_COLLECTION,
  checkVoteRecord,
  decideOutcome,
  knownProposalCids,
  proposalUri as buildProposalUri,
  tallyEpoch,
  voteOrderKey,
  type VoteChoice,
} from './decision-rules.js';

/**
 * Why a decision did not verify.
 *
 * These strings are the machine-readable half of the verdict. They are
 * deliberately narrow — a caller should be able to tell "someone rewrote a
 * vote" from "someone forged a signature" from "this decision is simply stale"
 * without reading prose. Keep them stable.
 *
 *   valid                — every check passed.
 *   superseded           — sound, but replaced by a later decision for the same
 *                          proposal, found in the community's signed repo. Not
 *                          a failure.
 *   malformed-decision   — the decision record does not have the shape the
 *                          lexicon requires, or contradicts itself (e.g.
 *                          `evidenceComplete` disagreeing with `uncountedVotes`,
 *                          the same voter cited twice).
 *   missing-evidence     — something needed to run a check was not supplied: a
 *                          repo export, a DID document, a signing key. Nothing
 *                          is known to be wrong; the check could not be made.
 *   forged-signature     — a repo export's commit signature does not verify
 *                          against the DID document's atproto key, or the commit
 *                          names a different DID than the export claims.
 *   tampered-evidence    — the decision or the proposal is not in the community's
 *                          signed repo at the cited CID, or its content does not
 *                          hash to that CID.
 *   tampered-vote        — a cited vote is not in the voter's signed repo at the
 *                          cited CID, its content does not hash to it, or the
 *                          decision reports it as saying something the signed
 *                          record does not say.
 *   ineligible-vote      — a cited vote is authentic but should not have counted:
 *                          wrong proposal, a CID outside the proposal's lineage,
 *                          cast before the latest amendment, or not the earliest
 *                          record from that voter.
 *   uncounted-vote       — an eligible vote exists in the supplied exports and
 *                          the decision does not cite it.
 *   miscounted-tally     — the published `tally` does not match the votes the
 *                          decision itself cites.
 *   insufficient-quorum  — fewer counted votes than the threshold the decision
 *                          itself publishes. Proven short: no alternative
 *                          history explains it.
 *   quorum-floor-unmet   — clears its own published threshold but not the one
 *                          the community's settings record currently requires.
 *                          Either an understated threshold or a quorum raised
 *                          after the fact; the settings record keeps no history,
 *                          so this names the ambiguity rather than accusing.
 *   wrong-outcome        — quorum was met, but the published outcome is not what
 *                          the rule produces from the counted votes.
 */
export type VerificationCode =
  | 'valid'
  | 'superseded'
  | 'malformed-decision'
  | 'missing-evidence'
  | 'forged-signature'
  | 'tampered-evidence'
  | 'tampered-vote'
  | 'ineligible-vote'
  | 'uncounted-vote'
  | 'miscounted-tally'
  | 'insufficient-quorum'
  | 'quorum-floor-unmet'
  | 'wrong-outcome';

export type FailureCode = Exclude<VerificationCode, 'valid' | 'superseded'>;

/**
 * Codes that can appear on a *note* — an observation that is never a reason to
 * reject. Failure codes appear here too, but only when something has explained
 * them away (the `uncounted-vote` entries a supersession excuses). The two
 * note-only codes exist so a consumer filtering on a string never has to guess
 * which sense it is in:
 *
 *   disclosed-gap      — the decision itself declared cache votes that produced
 *                        no countable record (`uncountedVotes`). An honest
 *                        disclosure, not a vote anyone left out.
 *   quorum-rule-drift  — the threshold the decision published differs from the
 *                        one the community's settings record now states, while
 *                        the tally still satisfies both.
 */
export type NoteCode = FailureCode | 'disclosed-gap' | 'quorum-rule-drift';

/**
 * Reported worst-first, and `code` is the head of this list.
 *
 * Evidence of dishonesty outranks everything: a forged signature or a rewritten
 * record is the headline even when it also makes the arithmetic wrong. A
 * malformed decision comes first only because nothing further can be trusted to
 * mean what it says. `missing-evidence` sits below the tamper codes (it accuses
 * nobody) but above the arithmetic ones (a check that could not run makes the
 * counts unreliable).
 */
const SEVERITY: FailureCode[] = [
  'malformed-decision',
  'forged-signature',
  'tampered-evidence',
  'tampered-vote',
  'ineligible-vote',
  'uncounted-vote',
  'missing-evidence',
  'miscounted-tally',
  'insufficient-quorum',
  'quorum-floor-unmet',
  'wrong-outcome',
];

export interface VerificationProblem {
  code: FailureCode;
  message: string;
  /** DID of the voter a vote-scoped problem concerns. */
  voter?: string;
  /** AT-URI of the record a problem concerns. */
  uri?: string;
}

export interface VerificationNote extends Omit<VerificationProblem, 'code'> {
  code: NoteCode;
}

/** A record as some other party cites it: location, hash, and claimed content. */
export interface CitedRecord {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

/**
 * A repo export reduced to what a verifier needs: the signed commit at its root
 * and every block reachable from it. Built from a CAR file by
 * `decision-evidence.ts`; nothing here knows about files.
 */
export interface RepoProof {
  /** DID the export claims to be. Checked against the commit, never trusted. */
  did: string;
  /** CID of the signed commit — the CAR root. */
  commit: string;
  /** Commit block, MST nodes, and record values. */
  blocks: BlockMap;
}

/** Minimal W3C DID document shape; only the `#atproto` key is read. */
export interface DidDocumentLike {
  id: string;
  [key: string]: unknown;
}

export interface VerifyDecisionInput {
  /** The decision under verification. */
  decision: CitedRecord;
  /** The proposal it cites, as currently held in the community repo. */
  proposal: CitedRecord;
  /** Signed exports for the community and every voter whose vote is relied on. */
  repos: RepoProof[];
  /** DID documents from a caller-supplied source. Never resolved over the network. */
  didDocuments: DidDocumentLike[];
  /** Other decisions for the same proposal, so supersession is visible. */
  siblingDecisions?: CitedRecord[];
}

export interface DecisionVerdict {
  status: 'valid' | 'superseded' | 'invalid';
  /** The most severe failure, or `valid` / `superseded`. */
  code: VerificationCode;
  /** Every failure found, worst first. Empty when `status` is not `invalid`. */
  problems: VerificationProblem[];
  /** Disclosed, expected conditions — never a reason to reject. */
  notes: VerificationNote[];
  summary: {
    decisionUri: string;
    community: string | null;
    proposalRkey: string | null;
    outcome: string | null;
    /** The threshold the decision publishes about itself. */
    quorumThreshold: number | null;
    /** The threshold the community's signed settings record requires. */
    settingsQuorumThreshold: number | null;
    /** The larger of the two — publishing a smaller number cannot lower the bar. */
    effectiveQuorumThreshold: number | null;
    citedVotes: number;
    /** Cited votes proved against a signed repo and found eligible. */
    verifiedVotes: number;
    countedFor: number;
    countedAgainst: number;
    /** Eligible votes found in the exports, cited or not. */
    eligibleVotesFound: number;
    evidenceComplete: boolean;
    disclosedUncounted: number;
    supersedes?: string;
    supersededBy?: string;
  };
}

/** A repo export that has been parsed and had its commit signature checked. */
interface LoadedRepo {
  did: string;
  repo: Repo | null;
  blocks: BlockMap;
  signatureVerified: boolean;
}

interface EligibleVote {
  voter: string;
  rkey: string;
  cid: string;
  vote: VoteChoice;
  proposalCid: string;
  orderKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAtUri(uri: unknown): { repo: string; collection: string; rkey: string } | null {
  if (typeof uri !== 'string' || !uri.startsWith('at://')) return null;
  const parts = uri.slice('at://'.length).split('/');
  if (parts.length !== 3 || parts.some(p => p.length === 0)) return null;
  return { repo: parts[0], collection: parts[1], rkey: parts[2] };
}

/**
 * Load a repo export and decide whether to believe it.
 *
 * A commit whose signature does not verify is not treated as "absent": the
 * export is kept so records can still be located and reported on, but
 * `signatureVerified` stays false and nothing downstream counts it as proof.
 */
async function loadRepo(
  proof: RepoProof,
  didDocs: Map<string, DidDocumentLike>,
  problems: VerificationProblem[],
): Promise<LoadedRepo> {
  const storage = new MemoryBlockstore(proof.blocks);
  let repo: Repo;
  try {
    repo = await Repo.load(storage, CID.parse(proof.commit));
  } catch (err) {
    problems.push({
      code: 'missing-evidence',
      message: `repo export for ${proof.did} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      voter: proof.did,
    });
    return { did: proof.did, repo: null, blocks: proof.blocks, signatureVerified: false };
  }

  if (repo.commit.did !== proof.did) {
    problems.push({
      code: 'forged-signature',
      message: `repo export claims ${proof.did} but its signed commit names ${repo.commit.did}`,
      voter: proof.did,
    });
    return { did: proof.did, repo, blocks: proof.blocks, signatureVerified: false };
  }

  const doc = didDocs.get(proof.did);
  if (!doc) {
    problems.push({
      code: 'missing-evidence',
      message: `no DID document supplied for ${proof.did}; its commit signature cannot be checked`,
      voter: proof.did,
    });
    return { did: proof.did, repo, blocks: proof.blocks, signatureVerified: false };
  }

  const didKey = getKey(doc as never);
  if (!didKey) {
    problems.push({
      code: 'missing-evidence',
      message: `DID document for ${proof.did} has no atproto signing key`,
      voter: proof.did,
    });
    return { did: proof.did, repo, blocks: proof.blocks, signatureVerified: false };
  }

  let ok = false;
  try {
    ok = await verifyCommitSig(repo.commit, didKey);
  } catch {
    ok = false;
  }
  if (!ok) {
    problems.push({
      code: 'forged-signature',
      message: `commit signature for ${proof.did} does not verify against its atproto key`,
      voter: proof.did,
    });
  }
  return { did: proof.did, repo, blocks: proof.blocks, signatureVerified: ok };
}

type Located =
  | { found: true; cid: string; value: Record<string, unknown> }
  | { found: false; reason: string };

/**
 * Find a record by walking the MST from the signed commit, and check that the
 * bytes stored under its CID really hash to it. Both halves matter: the MST
 * walk is what ties the record to the signature, the hash check is what stops a
 * block map from carrying content that does not match its key.
 */
async function locateRecord(loaded: LoadedRepo, collection: string, rkey: string): Promise<Located> {
  if (!loaded.repo) return { found: false, reason: 'no readable repo export' };
  let cid: CID | null;
  try {
    cid = await loaded.repo.data.get(formatDataKey(collection, rkey));
  } catch (err) {
    return { found: false, reason: `MST walk failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!cid) return { found: false, reason: 'not present in the signed repo' };

  const bytes = loaded.blocks.get(cid);
  if (!bytes) return { found: false, reason: 'record block missing from the export' };

  let value: Record<string, unknown>;
  try {
    value = cborToLexRecord(bytes) as Record<string, unknown>;
  } catch (err) {
    return { found: false, reason: `record block is not a decodable record: ${err instanceof Error ? err.message : String(err)}` };
  }

  const recomputed = await cidForRecord(value);
  if (!recomputed.equals(cid)) {
    return { found: false, reason: 'record content does not hash to the CID it is stored under' };
  }
  return { found: true, cid: cid.toString(), value };
}

/**
 * Verify a governance decision against the evidence it cites.
 *
 * Pure: no database, no network, no clock. Returns a verdict rather than
 * throwing — an unverifiable decision is a result, not an exception.
 */
export async function verifyDecision(input: VerifyDecisionInput): Promise<DecisionVerdict> {
  const problems: VerificationProblem[] = [];
  const notes: VerificationNote[] = [];

  const decisionValue = input.decision.value ?? {};
  const community = typeof decisionValue.community === 'string' ? decisionValue.community : null;
  const proposalRkey = typeof decisionValue.proposalRkey === 'string' ? decisionValue.proposalRkey : null;
  const outcome = typeof decisionValue.outcome === 'string' ? decisionValue.outcome : null;
  const quorum = isRecord(decisionValue.quorum) ? decisionValue.quorum : null;
  const quorumThreshold = typeof quorum?.threshold === 'number' ? quorum.threshold : null;
  const citedVotes = Array.isArray(decisionValue.votes) ? decisionValue.votes : [];
  const disclosedUncounted = Array.isArray(decisionValue.uncountedVotes) ? decisionValue.uncountedVotes : [];
  const evidenceComplete = decisionValue.evidenceComplete === true;

  const summary: DecisionVerdict['summary'] = {
    decisionUri: input.decision.uri,
    community,
    proposalRkey,
    outcome,
    quorumThreshold,
    settingsQuorumThreshold: null,
    effectiveQuorumThreshold: quorumThreshold,
    citedVotes: citedVotes.length,
    verifiedVotes: 0,
    countedFor: 0,
    countedAgainst: 0,
    eligibleVotesFound: 0,
    evidenceComplete,
    disclosedUncounted: disclosedUncounted.length,
  };

  const finish = (): DecisionVerdict => {
    const supersededBy = summary.supersededBy;
    // A superseded decision is legitimately stale: the votes that arrived
    // between it and its replacement are absent by construction, so their
    // absence is an observation rather than a defect. Everything else — a
    // forged signature, a rewritten vote — still fails.
    let effective = problems;
    if (supersededBy) {
      effective = problems.filter(p => p.code !== 'uncounted-vote');
      for (const p of problems) if (p.code === 'uncounted-vote') notes.push(p);
    }
    effective.sort((a, b) => SEVERITY.indexOf(a.code) - SEVERITY.indexOf(b.code));
    if (effective.length > 0) {
      return { status: 'invalid', code: effective[0].code, problems: effective, notes, summary };
    }
    return {
      status: supersededBy ? 'superseded' : 'valid',
      code: supersededBy ? 'superseded' : 'valid',
      problems: [],
      notes,
      summary,
    };
  };

  // ── Shape of the decision itself ──────────────────────────────────
  const decisionLoc = parseAtUri(input.decision.uri);
  if (!decisionLoc || decisionLoc.collection !== DECISION_COLLECTION) {
    problems.push({ code: 'malformed-decision', message: `decision uri is not a ${DECISION_COLLECTION} record uri`, uri: input.decision.uri });
    return finish();
  }
  if (!community || !proposalRkey || !outcome || quorumThreshold === null) {
    problems.push({ code: 'malformed-decision', message: 'decision record is missing community, proposalRkey, outcome, or quorum.threshold', uri: input.decision.uri });
    return finish();
  }
  if (decisionLoc.repo !== community) {
    problems.push({ code: 'malformed-decision', message: `decision is at ${decisionLoc.repo} but names community ${community}`, uri: input.decision.uri });
    return finish();
  }
  if (outcome !== 'approved' && outcome !== 'rejected') {
    problems.push({ code: 'malformed-decision', message: `unknown outcome "${outcome}"`, uri: input.decision.uri });
  }
  if (evidenceComplete !== (disclosedUncounted.length === 0)) {
    problems.push({
      code: 'malformed-decision',
      message: `evidenceComplete is ${evidenceComplete} but uncountedVotes has ${disclosedUncounted.length} entr${disclosedUncounted.length === 1 ? 'y' : 'ies'}`,
      uri: input.decision.uri,
    });
  }
  if (!evidenceComplete) {
    notes.push({
      code: 'disclosed-gap',
      message: `decision discloses ${disclosedUncounted.length} cached vote(s) that produced no countable record; this is a declared gap, not a defect`,
      uri: input.decision.uri,
    });
  }
  if (isRecord(decisionValue.supersedes) && typeof decisionValue.supersedes.uri === 'string') {
    summary.supersedes = decisionValue.supersedes.uri;
  }

  // ── Signed repo exports ───────────────────────────────────────────
  const didDocs = new Map<string, DidDocumentLike>();
  for (const doc of input.didDocuments ?? []) {
    if (doc && typeof doc.id === 'string') didDocs.set(doc.id, doc);
  }

  const repos = new Map<string, LoadedRepo>();
  for (const proof of input.repos ?? []) {
    repos.set(proof.did, await loadRepo(proof, didDocs, problems));
  }

  const communityRepo = repos.get(community);
  if (!communityRepo) {
    problems.push({ code: 'missing-evidence', message: `no repo export supplied for community ${community}`, voter: community });
    return finish();
  }

  // ── Supersession, before anything is judged stale ─────────────────
  //
  // A supersession excuses exactly the failure this function exists to raise:
  // eligible votes the decision does not count. So the claim is never taken on
  // the caller's word. The superseding record has to be in the community's own
  // signed repo at the CID it is offered under, and the `supersedes` reference
  // is read out of the *repo's* copy rather than the caller's — otherwise a
  // fabricated sibling could silence a genuine `uncounted-vote`.
  if (communityRepo.signatureVerified) {
    for (const sibling of input.siblingDecisions ?? []) {
      if (sibling.uri === input.decision.uri) continue;
      const loc = parseAtUri(sibling.uri);
      if (!loc || loc.repo !== community || loc.collection !== DECISION_COLLECTION) continue;

      const inRepo = await locateRecord(communityRepo, DECISION_COLLECTION, loc.rkey);
      if (!inRepo.found || inRepo.cid !== sibling.cid) continue;

      const ref = inRepo.value.supersedes;
      if (isRecord(ref) && ref.uri === input.decision.uri && ref.cid === input.decision.cid) {
        summary.supersededBy = sibling.uri;
        break;
      }
    }
  }

  // ── The decision and the proposal are in the community's signed repo ──
  const decisionInRepo = await locateRecord(communityRepo, DECISION_COLLECTION, decisionLoc.rkey);
  if (!decisionInRepo.found) {
    problems.push({ code: 'tampered-evidence', message: `decision record: ${decisionInRepo.reason}`, uri: input.decision.uri });
  } else if (decisionInRepo.cid !== input.decision.cid) {
    problems.push({
      code: 'tampered-evidence',
      message: `decision is cited at ${input.decision.cid} but the signed repo holds ${decisionInRepo.cid}`,
      uri: input.decision.uri,
    });
  } else {
    const recomputed = await cidForRecord(input.decision.value);
    if (recomputed.toString() !== input.decision.cid) {
      problems.push({ code: 'tampered-evidence', message: 'decision content does not hash to its cited CID', uri: input.decision.uri });
    }
  }

  const expectedProposalUri = buildProposalUri(community, proposalRkey);
  const proposalLoc = parseAtUri(input.proposal.uri);
  if (input.proposal.uri !== expectedProposalUri || !proposalLoc) {
    problems.push({
      code: 'tampered-evidence',
      message: `supplied proposal ${input.proposal.uri} is not the proposal this decision resolves (${expectedProposalUri})`,
      uri: input.proposal.uri,
    });
    return finish();
  }
  const proposalInRepo = await locateRecord(communityRepo, PROPOSAL_COLLECTION, proposalRkey);
  if (!proposalInRepo.found) {
    problems.push({ code: 'tampered-evidence', message: `proposal record: ${proposalInRepo.reason}`, uri: input.proposal.uri });
  } else if (proposalInRepo.cid !== input.proposal.cid) {
    problems.push({
      code: 'tampered-evidence',
      message: `proposal is supplied at ${input.proposal.cid} but the signed repo holds ${proposalInRepo.cid}`,
      uri: input.proposal.uri,
    });
  } else {
    const recomputed = await cidForRecord(input.proposal.value);
    if (recomputed.toString() !== input.proposal.cid) {
      problems.push({ code: 'tampered-evidence', message: 'proposal content does not hash to its cited CID', uri: input.proposal.uri });
    }
  }

  // The decision must cite the proposal, at a state the proposal passed
  // through. The lineage is what keeps that checkable after the resolution
  // rewrite changed the proposal's current CID.
  const citedProposal = isRecord(decisionValue.proposal) ? decisionValue.proposal : null;
  const knownCids = knownProposalCids(input.proposal.value, input.proposal.cid);
  if (!citedProposal || citedProposal.uri !== expectedProposalUri || decisionValue.proposalCollection !== PROPOSAL_COLLECTION) {
    problems.push({ code: 'malformed-decision', message: 'decision does not cite its proposal by uri and collection', uri: input.decision.uri });
  } else if (typeof citedProposal.cid !== 'string' || !knownCids.has(citedProposal.cid)) {
    problems.push({
      code: 'tampered-evidence',
      message: `decision cites proposal CID ${String(citedProposal.cid)}, which is not in the proposal's CID lineage`,
      uri: input.decision.uri,
    });
  }

  // ── What the exports say the tally should be ──────────────────────
  const eligibility = {
    proposalUri: expectedProposalUri,
    knownCids,
    epoch: tallyEpoch(input.proposal.value),
  };

  /** voter DID -> the vote record that counts for them, from the exports alone. */
  const eligible = new Map<string, EligibleVote>();
  for (const loaded of repos.values()) {
    // An export whose signature did not verify proves nothing, so it cannot be
    // used to claim a vote was missed either.
    if (!loaded.repo || !loaded.signatureVerified) continue;
    for await (const entry of loaded.repo.walkRecords()) {
      if (entry.collection !== VOTE_COLLECTION) continue;
      const record = entry.record as Record<string, any>;
      if (record?.community !== community || record?.proposalRkey !== proposalRkey) continue;
      const result = checkVoteRecord(record, eligibility);
      if (!result.countable) continue;
      const key = voteOrderKey(result.createdAt, entry.rkey);
      const previous = eligible.get(loaded.did);
      if (previous !== undefined && previous.orderKey <= key) continue;
      eligible.set(loaded.did, {
        voter: loaded.did,
        rkey: entry.rkey,
        cid: entry.cid.toString(),
        vote: result.vote,
        proposalCid: result.proposalCid,
        orderKey: key,
      });
    }
  }
  summary.eligibleVotesFound = eligible.size;

  // ── Every cited vote ──────────────────────────────────────────────
  const citedVoters = new Set<string>();
  let countedFor = 0;
  let countedAgainst = 0;

  for (const raw of citedVotes) {
    if (!isRecord(raw)) {
      problems.push({ code: 'malformed-decision', message: 'votes[] contains a non-object entry', uri: input.decision.uri });
      continue;
    }
    const voter = typeof raw.voter === 'string' ? raw.voter : null;
    const choice = raw.vote === 'for' || raw.vote === 'against' ? (raw.vote as VoteChoice) : null;
    const ref = isRecord(raw.record) ? raw.record : null;
    const refUri = typeof ref?.uri === 'string' ? ref.uri : null;
    const refCid = typeof ref?.cid === 'string' ? ref.cid : null;

    if (!voter || !choice || !refUri || !refCid) {
      problems.push({ code: 'malformed-decision', message: 'votes[] entry is missing voter, vote, or record ref', uri: input.decision.uri });
      continue;
    }
    if (choice === 'for') countedFor++; else countedAgainst++;

    if (citedVoters.has(voter)) {
      problems.push({ code: 'malformed-decision', message: `voter ${voter} is counted more than once`, voter, uri: input.decision.uri });
      continue;
    }
    citedVoters.add(voter);

    const voteLoc = parseAtUri(refUri);
    if (!voteLoc || voteLoc.repo !== voter || voteLoc.collection !== VOTE_COLLECTION) {
      problems.push({ code: 'malformed-decision', message: `cited vote uri ${refUri} is not a ${VOTE_COLLECTION} record in ${voter}'s repo`, voter, uri: refUri });
      continue;
    }

    const loaded = repos.get(voter);
    if (!loaded) {
      problems.push({ code: 'missing-evidence', message: `no repo export supplied for voter ${voter}`, voter, uri: refUri });
      continue;
    }
    if (!loaded.signatureVerified) {
      // The repo-level forged-signature / missing-evidence problem is already
      // recorded; the vote simply cannot count as verified.
      continue;
    }

    const located = await locateRecord(loaded, VOTE_COLLECTION, voteLoc.rkey);
    if (!located.found) {
      problems.push({ code: 'tampered-vote', message: `cited vote ${refUri}: ${located.reason}`, voter, uri: refUri });
      continue;
    }
    if (located.cid !== refCid) {
      problems.push({
        code: 'tampered-vote',
        message: `vote is cited at ${refCid} but ${voter}'s signed repo holds ${located.cid}`,
        voter,
        uri: refUri,
      });
      continue;
    }

    const record = located.value as Record<string, any>;
    if (record.vote !== choice) {
      problems.push({ code: 'tampered-vote', message: `decision reports ${voter} voting "${choice}" but the signed record says "${String(record.vote)}"`, voter, uri: refUri });
      continue;
    }
    if (typeof raw.proposalCid === 'string' && raw.proposalCid !== record?.proposal?.cid) {
      problems.push({ code: 'tampered-vote', message: `decision reports ${voter} attesting to proposal CID ${raw.proposalCid} but the signed record cites ${String(record?.proposal?.cid)}`, voter, uri: refUri });
      continue;
    }

    const result = checkVoteRecord(record, eligibility);
    if (!result.countable) {
      problems.push({ code: 'ineligible-vote', message: `counted vote from ${voter} is not countable: ${result.reason}`, voter, uri: refUri });
      continue;
    }
    const winner = eligible.get(voter);
    if (winner && winner.rkey !== voteLoc.rkey) {
      problems.push({
        code: 'ineligible-vote',
        message: `counted vote from ${voter} is not that voter's earliest eligible record (at://${voter}/${VOTE_COLLECTION}/${winner.rkey} is)`,
        voter,
        uri: refUri,
      });
      continue;
    }
    summary.verifiedVotes++;
  }

  summary.countedFor = countedFor;
  summary.countedAgainst = countedAgainst;

  // ── Nothing eligible was left out ─────────────────────────────────
  for (const [voter, vote] of eligible) {
    if (citedVoters.has(voter)) continue;
    problems.push({
      code: 'uncounted-vote',
      message: `${voter} has an eligible "${vote.vote}" vote record that this decision does not count`,
      voter,
      uri: `at://${voter}/${VOTE_COLLECTION}/${vote.rkey}`,
    });
  }

  // ── The published arithmetic ──────────────────────────────────────
  const tally = isRecord(decisionValue.tally) ? decisionValue.tally : null;
  if (!tally || tally.votesFor !== countedFor || tally.votesAgainst !== countedAgainst || tally.total !== citedVotes.length) {
    problems.push({
      code: 'miscounted-tally',
      message: `published tally (for ${String(tally?.votesFor)}, against ${String(tally?.votesAgainst)}, total ${String(tally?.total)}) does not match the votes cited (for ${countedFor}, against ${countedAgainst}, total ${citedVotes.length})`,
      uri: input.decision.uri,
    });
  }

  // The quorum rule the decision publishes is a claim about itself. Taking it
  // at face value would make `insufficient-quorum` unenforceable against the
  // one adversary that matters: a PDS resolving a one-vote decision in a
  // quorum-five community and writing `threshold: 1` on the record. The rule
  // resolution actually applied comes from the community's settings record
  // (`voteOnProposal` reads `governanceConfig.quorum || 3`), which lives in the
  // community repo and is therefore already signature-checked here.
  //
  // That record is mutable and keeps no lineage, so it states the rule *now*,
  // not the rule at resolution time. Publishing a smaller threshold must never
  // lower the bar, so the effective threshold is the larger of the two — a
  // decision has to satisfy both what it claimed and what the community
  // requires.
  const settingsInRepo = await locateRecord(communityRepo, SETTINGS_COLLECTION, 'self');
  let settingsThreshold: number | null = null;
  if (!settingsInRepo.found) {
    problems.push({
      code: 'missing-evidence',
      message: `community settings record (${SETTINGS_COLLECTION}/self) is not in the export: ${settingsInRepo.reason}. The quorum rule the decision publishes cannot be checked against the community's own.`,
      voter: community,
    });
  } else {
    const config = isRecord(settingsInRepo.value.governanceConfig) ? settingsInRepo.value.governanceConfig : null;
    // Same expression the online path applies, `|| 3` included.
    settingsThreshold = (typeof config?.quorum === 'number' ? config.quorum : 0) || DEFAULT_QUORUM;
    summary.settingsQuorumThreshold = settingsThreshold;
  }

  const effectiveThreshold = settingsThreshold === null
    ? quorumThreshold
    : Math.max(quorumThreshold, settingsThreshold);
  summary.effectiveQuorumThreshold = effectiveThreshold;

  if (settingsThreshold !== null && settingsThreshold !== quorumThreshold) {
    notes.push({
      code: 'quorum-rule-drift',
      message: `decision publishes a quorum threshold of ${quorumThreshold}; the community's settings record requires ${settingsThreshold}. ${effectiveThreshold} was applied.`,
      uri: input.decision.uri,
    });
  }

  // Both shortfalls are failures, but they are not the same finding and must
  // not share a string.
  //
  //   total < published            — short of a rule the decision itself admits
  //                                  to. No alternative history explains it.
  //                                  Proof: `insufficient-quorum`.
  //   published <= total < settings — clears its own stated rule, short only
  //                                  under a rule that may postdate it. Could
  //                                  be a forged threshold, could be a quorum
  //                                  the community raised afterwards, and the
  //                                  settings record carries no lineage to tell
  //                                  them apart. Suspicion, named as such:
  //                                  `quorum-floor-unmet`.
  //
  // Collapsing the second into the first would make an honest historical
  // decision re-verify under the same code as the forged-threshold attack.
  const total = countedFor + countedAgainst;
  if (total < quorumThreshold) {
    problems.push({
      code: 'insufficient-quorum',
      message: `${total} counted vote(s) is below the quorum threshold of ${quorumThreshold} that this decision itself publishes`,
      uri: input.decision.uri,
    });
  } else if (total < effectiveThreshold) {
    problems.push({
      code: 'quorum-floor-unmet',
      message:
        `${total} counted vote(s) clears the threshold of ${quorumThreshold} this decision publishes, but not the ${effectiveThreshold} ` +
        `the community's settings record currently requires. Either the published threshold was understated, or the community raised its ` +
        `quorum after this decision resolved — the settings record keeps no history, so the two cannot be told apart offline.`,
      uri: input.decision.uri,
    });
  } else {
    const expected = decideOutcome(countedFor, countedAgainst, effectiveThreshold);
    if (expected !== outcome) {
      problems.push({
        code: 'wrong-outcome',
        message: `the published rule applied to ${countedFor} for / ${countedAgainst} against yields "${String(expected)}", not "${outcome}"`,
        uri: input.decision.uri,
      });
    }
  }

  return finish();
}
