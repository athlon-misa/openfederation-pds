/**
 * Objector-signed governance objection records.
 *
 * An objection is the member's own act, not the PDS's report of it: like a vote
 * it is written into the objector's repo and signed with the objector's key, so
 * a third party can check who contested an application without trusting the
 * community's PDS.
 *
 * Unlike `writeVoteRecord`, a failure here is *not* swallowed. A counted vote
 * whose record fails to write is still a counted vote (the proposal's arrays
 * already hold it) and the gap is audited; an objection that produces no record
 * is not an objection at all. Holding a community's decision on evidence that
 * does not exist is precisely the operator-trust this refactor removes — so the
 * write throwing means the objection was not accepted, and the caller is told.
 */

import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';

export { OBJECTION_COLLECTION } from './decision-rules.js';
import { OBJECTION_COLLECTION, PROPOSAL_COLLECTION, proposalUri } from './decision-rules.js';
import type { StrongRef } from './vote-records.js';

export interface ObjectionRecordInput {
  /** Repo the record is written to, and whose key signs it. */
  objectorDid: string;
  communityDid: string;
  proposalRkey: string;
  /** CID of the proposal record as it stood when the objection was raised. */
  proposalCid: string;
  /** The decision whose application is being contested. */
  decision: StrongRef;
  /** Free-text rationale, published with the record. */
  reason?: string;
}

export interface ObjectionRecordResult {
  objectorDid: string;
  uri: string;
  cid: string;
  rkey: string;
  createdAt: string;
}

/**
 * Whether this DID can sign an objection record at all.
 *
 * Same determination `canRecordVote` makes for votes, and made for the same
 * reason: an account with no repo cannot produce the evidence, so it is told at
 * the moment it objects rather than having an unevidenced hold placed on the
 * community's governance. Throws if the check itself could not be made — "no
 * repo" is a verdict, a failed lookup is not.
 */
export async function canRecordObjection(objectorDid: string): Promise<boolean> {
  return new RepoEngine(objectorDid).hasRepo();
}

/**
 * Write one objector-signed objection record into the objector's own repo.
 * Throws if the repo, key, or commit fails — see the module note.
 */
export async function writeObjectionRecord(input: ObjectionRecordInput): Promise<ObjectionRecordResult> {
  const engine = new RepoEngine(input.objectorDid);
  const keypair = await getKeypairForDid(input.objectorDid);
  const rkey = RepoEngine.generateTid();
  const createdAt = new Date().toISOString();

  const record: Record<string, unknown> = {
    $type: OBJECTION_COLLECTION,
    community: input.communityDid,
    proposal: {
      uri: proposalUri(input.communityDid, input.proposalRkey),
      cid: input.proposalCid,
    },
    proposalCollection: PROPOSAL_COLLECTION,
    proposalRkey: input.proposalRkey,
    decision: input.decision,
    ...(input.reason ? { reason: input.reason } : {}),
    createdAt,
  };

  const { uri, cid } = await engine.putRecord(keypair, OBJECTION_COLLECTION, rkey, record);
  return { objectorDid: input.objectorDid, uri, cid, rkey, createdAt };
}
