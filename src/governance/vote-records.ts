/**
 * Voter-signed governance vote records.
 *
 * A vote counted in a proposal's `votesFor` / `votesAgainst` arrays is stored in
 * the *community's* repo and signed with the *community's* key — i.e. it is the
 * PDS operator's claim that someone voted. To make votes verifiable by third
 * parties, every counted vote is additionally written as a
 * `net.openfederation.governance.vote` record into the voter's own repo, signed
 * with the voter's key.
 *
 * This is a dual-write: the proposal record remains the authoritative tally.
 * Failures here are logged and swallowed so they never turn a counted vote into
 * an error response.
 */

import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';

export const VOTE_COLLECTION = 'net.openfederation.governance.vote';
export const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';

export interface StrongRef {
  uri: string;
  cid: string;
}

export interface VoteRecordInput {
  /** Repo the record is written to, and whose key signs it. */
  voterDid: string;
  communityDid: string;
  proposalRkey: string;
  /** CID of the proposal record as it stood when the vote was cast. */
  proposalCid: string;
  vote: 'for' | 'against';
  /** Delegate who cast this vote on the voter's behalf; absent for direct votes. */
  castBy?: string;
  /** The delegation record that authorised a delegated vote. */
  delegation?: StrongRef;
}

export interface VoteRecordResult {
  voterDid: string;
  uri: string;
  cid: string;
  rkey: string;
}

/**
 * Write one voter-signed vote record into the voter's own repo.
 * Returns null (and logs) if the voter has no repo or signing key, or if the
 * commit fails — the authoritative tally has already been written by then.
 */
export async function writeVoteRecord(input: VoteRecordInput): Promise<VoteRecordResult | null> {
  try {
    const engine = new RepoEngine(input.voterDid);
    if (!(await engine.hasRepo())) {
      console.warn(`[governance] skipping vote record: no repo for voter ${input.voterDid}`);
      return null;
    }

    const keypair = await getKeypairForDid(input.voterDid);
    const rkey = RepoEngine.generateTid();

    const record: Record<string, unknown> = {
      $type: VOTE_COLLECTION,
      community: input.communityDid,
      proposal: {
        uri: `at://${input.communityDid}/${PROPOSAL_COLLECTION}/${input.proposalRkey}`,
        cid: input.proposalCid,
      },
      proposalCollection: PROPOSAL_COLLECTION,
      proposalRkey: input.proposalRkey,
      vote: input.vote,
      ...(input.castBy ? { castBy: input.castBy } : {}),
      ...(input.delegation ? { delegation: input.delegation } : {}),
      createdAt: new Date().toISOString(),
    };

    const { uri, cid } = await engine.putRecord(keypair, VOTE_COLLECTION, rkey, record);
    return { voterDid: input.voterDid, uri, cid, rkey };
  } catch (error) {
    console.error(`[governance] failed to write vote record for ${input.voterDid}:`, error);
    return null;
  }
}

/**
 * Write vote records for a direct vote and every delegated vote it carried.
 * Records are written sequentially so a slow or broken repo affects only itself.
 */
export async function writeVoteRecords(inputs: VoteRecordInput[]): Promise<VoteRecordResult[]> {
  const results: VoteRecordResult[] = [];
  for (const input of inputs) {
    const result = await writeVoteRecord(input);
    if (result) results.push(result);
  }
  return results;
}
