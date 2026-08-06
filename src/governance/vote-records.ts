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
 * Failures here are swallowed so they never turn a counted vote into an error
 * response — but every counted vote that fails to produce a record is written to
 * `audit_log` as `community.proposal.vote.recordFailed`, so the divergence
 * between the tally and the record set stays enumerable instead of silent.
 */

import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';

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
 * Record a counted vote that produced no voter-signed record. The tally already
 * counts it, so the gap is permanent — the audit entry is the only way to find
 * it afterwards.
 */
async function auditMissingVoteRecord(input: VoteRecordInput, reason: string): Promise<void> {
  await auditLog(
    'community.proposal.vote.recordFailed',
    // audit_log.actor_id is VARCHAR(36); longer DIDs go to meta only so the
    // entry is still written.
    input.voterDid.length <= 36 ? input.voterDid : null,
    input.communityDid,
    {
      voterDid: input.voterDid,
      proposalRkey: input.proposalRkey,
      proposalCid: input.proposalCid,
      vote: input.vote,
      ...(input.castBy ? { castBy: input.castBy } : {}),
      reason,
    },
  );
}

/**
 * Whether a vote by this DID can produce a voter-signed record at all.
 *
 * A DID with no repo (external accounts, the bootstrap admin) can never sign a
 * vote record, so counting its vote would put an unevidenced name in the tally
 * permanently. Callers check this *before* counting, so the voter is told at
 * the moment they vote rather than through a governance deadlock later.
 */
export async function canRecordVote(voterDid: string): Promise<boolean> {
  try {
    return await new RepoEngine(voterDid).hasRepo();
  } catch (error) {
    console.error(`[governance] failed to check repo for ${voterDid}:`, error);
    return false;
  }
}

/**
 * Record a vote that was deliberately not counted because the voter could never
 * produce a record for it. Unlike `auditMissingVoteRecord` this is not a gap in
 * the tally — it is the tally refusing to grow — but it is logged the same way
 * so both remain enumerable from one place.
 */
export async function auditUnrecordableVote(input: VoteRecordInput): Promise<void> {
  await auditMissingVoteRecord(input, 'no-repo');
}

/**
 * Write one voter-signed vote record into the voter's own repo.
 * Returns null if the voter has no repo or signing key, or if the commit fails —
 * the authoritative tally has already been written by then, so the miss is
 * audited rather than raised.
 */
export async function writeVoteRecord(input: VoteRecordInput): Promise<VoteRecordResult | null> {
  try {
    const engine = new RepoEngine(input.voterDid);
    if (!(await engine.hasRepo())) {
      console.warn(`[governance] skipping vote record: no repo for voter ${input.voterDid}`);
      await auditMissingVoteRecord(input, 'no-repo');
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
    await auditMissingVoteRecord(input, error instanceof Error ? error.message : String(error));
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
