/**
 * Turning CAR exports into the inputs `verifyDecision` takes.
 *
 * Kept separate from the verifier for one reason: the verifier's whole value is
 * that it is trivially testable — records in, verdict out. Teaching it to parse
 * CAR containers, hunt for a decision, or read files would put I/O-shaped
 * concerns inside the thing that must have none. So this module does the
 * assembly and the verifier does the judging.
 *
 * Still pure with respect to the network and the database: it decodes bytes the
 * caller already has. Reading those bytes off disk is the CLI's job.
 */

import { Repo, MemoryBlockstore, readCarWithRoot } from '@atproto/repo';
import {
  DECISION_COLLECTION,
  PROPOSAL_COLLECTION,
} from './decision-rules.js';
import type { CitedRecord, RepoProof, VerifyDecisionInput, DidDocumentLike } from './verify-decision.js';

/** A parsed CAR export, plus the records that were read out of it. */
export interface ParsedRepo {
  proof: RepoProof;
  /** Every record in the export, keyed by `<collection>/<rkey>`. */
  records: Map<string, CitedRecord>;
}

/**
 * Parse one CAR export. The DID is taken from the signed commit rather than
 * from a filename or a flag — the export says who it is, and `verifyDecision`
 * then checks that claim against a DID document.
 */
export async function parseRepoCar(bytes: Uint8Array): Promise<ParsedRepo> {
  const { root, blocks } = await readCarWithRoot(bytes);
  const storage = new MemoryBlockstore(blocks);
  const repo = await Repo.load(storage, root);

  const records = new Map<string, CitedRecord>();
  for await (const entry of repo.walkRecords()) {
    records.set(`${entry.collection}/${entry.rkey}`, {
      uri: `at://${repo.did}/${entry.collection}/${entry.rkey}`,
      cid: entry.cid.toString(),
      value: entry.record as Record<string, unknown>,
    });
  }

  return {
    proof: { did: repo.did, commit: root.toString(), blocks },
    records,
  };
}

export interface DecisionCandidate {
  /** The community repo the decision was found in. */
  community: string;
  rkey: string;
  record: CitedRecord;
  proposalRkey: string | null;
}

/** Every decision record across the supplied exports. */
export function findDecisions(repos: ParsedRepo[]): DecisionCandidate[] {
  const found: DecisionCandidate[] = [];
  for (const parsed of repos) {
    for (const [key, record] of parsed.records) {
      if (!key.startsWith(`${DECISION_COLLECTION}/`)) continue;
      const rkey = key.slice(DECISION_COLLECTION.length + 1);
      const proposalRkey = typeof record.value.proposalRkey === 'string' ? record.value.proposalRkey : null;
      found.push({ community: parsed.proof.did, rkey, record, proposalRkey });
    }
  }
  return found;
}

export class EvidenceError extends Error {}

/**
 * Assemble the verifier's input for one decision: the decision itself, the
 * proposal it names, every export as a repo proof, the supplied DID documents,
 * and the sibling decisions for the same proposal — without which a superseded
 * decision would be indistinguishable from a stale one.
 */
export function buildVerifyInput(
  decision: DecisionCandidate,
  repos: ParsedRepo[],
  didDocuments: DidDocumentLike[],
): VerifyDecisionInput {
  if (!decision.proposalRkey) {
    throw new EvidenceError(`decision ${decision.record.uri} does not name a proposalRkey`);
  }
  const community = typeof decision.record.value.community === 'string'
    ? decision.record.value.community
    : decision.community;

  const communityRepo = repos.find(r => r.proof.did === community);
  if (!communityRepo) {
    throw new EvidenceError(`no CAR export supplied for community ${community}`);
  }
  const proposal = communityRepo.records.get(`${PROPOSAL_COLLECTION}/${decision.proposalRkey}`);
  if (!proposal) {
    throw new EvidenceError(
      `proposal ${decision.proposalRkey} is not in the export for ${community}; the decision cannot be checked against it`,
    );
  }

  const siblingDecisions: CitedRecord[] = [];
  for (const [key, record] of communityRepo.records) {
    if (!key.startsWith(`${DECISION_COLLECTION}/`)) continue;
    if (record.uri === decision.record.uri) continue;
    if (record.value.proposalRkey !== decision.proposalRkey) continue;
    siblingDecisions.push(record);
  }

  return {
    decision: decision.record,
    proposal,
    repos: repos.map(r => r.proof),
    didDocuments,
    siblingDecisions,
  };
}

/**
 * Accept either shape a DID-document file plausibly comes in: a JSON array of
 * documents, or an object keyed by DID.
 */
export function parseDidDocuments(parsed: unknown): DidDocumentLike[] {
  if (Array.isArray(parsed)) return parsed as DidDocumentLike[];
  if (parsed && typeof parsed === 'object') {
    const values = Object.values(parsed as Record<string, unknown>);
    if (values.every(v => v && typeof v === 'object')) return values as DidDocumentLike[];
  }
  throw new EvidenceError('DID document file must be a JSON array of documents or an object keyed by DID');
}
