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
import { isDeviceSigningOn } from '../repo/device-signing-state.js';
import { writeRepoAs, actingDevice } from '../repo/device-actions.js';

export { OBJECTION_COLLECTION } from './decision-rules.js';
import { OBJECTION_COLLECTION, PROPOSAL_COLLECTION, proposalUri } from './decision-rules.js';
import type { StrongRef } from './vote-records.js';
import { isPrivateCommunity, writeMemberContent } from '../forum/member-content.js';

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
  // As for votes: under device signing (#240) the server cannot sign it; the
  // objector's device can, when it takes part in this request.
  if (await isDeviceSigningOn(objectorDid) && !actingDevice(objectorDid)) return false;
  return new RepoEngine(objectorDid).hasRepo();
}

/**
 * Write one objector-signed objection record into the objector's own repo.
 * Throws if the repo, key, or commit fails — see the module note.
 */
export async function writeObjectionRecord(input: ObjectionRecordInput): Promise<ObjectionRecordResult> {
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

  // As for votes: a private community keeps the objector-signed record in its
  // own member-only repository, not in the objector's public one.
  if (await isPrivateCommunity(input.communityDid)) {
    const stored = await writeMemberContent({
      communityDid: input.communityDid, authorDid: input.objectorDid, collection: OBJECTION_COLLECTION,
      record, rkey, private: true,
    });
    const storedAt = stored.record.createdAt;
    return { objectorDid: input.objectorDid, uri: stored.uri, cid: stored.cid, rkey: stored.rkey, createdAt: typeof storedAt === 'string' ? storedAt : createdAt };
  }

  // The objector's device signs it when it takes part in this request (#240).
  const [written] = await writeRepoAs(input.objectorDid, [{ action: 'write', collection: OBJECTION_COLLECTION, rkey, record }]);
  const stored = written.record ?? record;
  return {
    objectorDid: input.objectorDid, uri: written.uri, cid: written.cid!, rkey: written.rkey,
    createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : createdAt,
  };
}
