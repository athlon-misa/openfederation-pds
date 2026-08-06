/**
 * Crash-atomic proposal resolution (#188).
 *
 * Resolution used to write the terminal proposal record and the change it
 * authorized in separate commits, so a crash between them left a durable
 * `approved` proposal whose change had never happened — and, because the
 * proposal was no longer `pending-application`, nothing would ever revisit it.
 * The decision record was a third separate commit before both.
 *
 * All three are now one signed commit, and `PgBlockstore.applyCommit` writes
 * its blocks and its root inside a single Postgres transaction. So the property
 * under test is not "the failure is recoverable" but "the failure cannot
 * happen": the repo holds the decision, the closed proposal and the change, or
 * it holds none of them.
 *
 * The faults are injected at the layer that would really fail — the blockstore
 * transaction — rather than simulated by hand-editing records, because a test
 * that writes the corrupt state itself proves only that the state is
 * detectable, not that it is unreachable.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { PgBlockstore } from '../../src/repo/pg-blockstore.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { query } from '../../src/db/client.js';
import { putProposalRecord } from '../../src/governance/proposal-resolution.js';

/**
 * Fail every commit to one repo, and only that one.
 *
 * Scoping matters: a resolving vote commits the voter's own vote record before
 * it commits anything of the community's, so a blanket one-shot failure would
 * land on the vote record instead — which `writeVoteRecords` swallows by
 * design, leaving the resolution merely deferred rather than crashed, and the
 * test would pass while proving nothing.
 */
function failCommitsFor(did: string) {
  const original = PgBlockstore.prototype.applyCommit;
  return vi.spyOn(PgBlockstore.prototype, 'applyCommit')
    .mockImplementation(async function (this: any, commit: any) {
      if (this.did === did) throw new Error('injected: process died mid-commit');
      return original.call(this, commit);
    });
}

/**
 * Let one repo's first commit through, then fail the rest.
 *
 * This is the fault that tells atomicity apart from luck. Failing *every*
 * commit proves little: under the old three-commit resolution the first one
 * would fail too and nothing would land, so the repo would look just as clean
 * as it does now. The reported bug needs the earlier commits to *succeed* and a
 * later one to die — decision and close durable, change lost — so the survival
 * count is swept rather than fixed. A single commit passes at every count,
 * because there is no later commit to lose.
 */
function failCommitsAfterFirstFor(did: string, survive: number) {
  const original = PgBlockstore.prototype.applyCommit;
  let seen = 0;
  return vi.spyOn(PgBlockstore.prototype, 'applyCommit')
    .mockImplementation(async function (this: any, commit: any) {
      if (this.did !== did) return original.call(this, commit);
      if (seen++ < survive) return original.call(this, commit);
      throw new Error(`injected: process died after commit ${survive}`);
    });
}

const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
const DECISION_COLLECTION = 'net.openfederation.governance.decision';
const TARGET_COLLECTION = 'app.example.governed';

type User = { accessJwt: string; did: string; handle: string };

async function proposalRecord(communityDid: string, rkey: string) {
  const res = await query<{ record: any }>(
    `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, PROPOSAL_COLLECTION, rkey],
  );
  return res.rows[0]?.record;
}

async function decisionsFor(communityDid: string, proposalRkey: string) {
  const res = await query<{ rkey: string; record: any }>(
    `SELECT rkey, record FROM records_index
     WHERE community_did = $1 AND collection = $2 AND record->>'proposalRkey' = $3`,
    [communityDid, DECISION_COLLECTION, proposalRkey],
  );
  return res.rows;
}

/** What the repo itself says, walking the MST rather than reading the cache. */
async function inRepo(communityDid: string, collection: string, rkey: string) {
  const engine = new RepoEngine(communityDid);
  const records = await engine.exportAllRecords();
  return records.find(r => r.collection === collection && r.rkey === rkey) ?? null;
}

describe('Crash-atomic proposal resolution (#188)', () => {
  let plcAvailable: boolean;
  let owner: User;
  let voter: User;
  let communityDid: string;

  const QUORUM = 2;

  async function createProposal(targetRkey: string, action: 'write' | 'delete' = 'write') {
    const res = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid,
      targetCollection: TARGET_COLLECTION,
      targetRkey,
      action,
      ...(action === 'write' ? { proposedRecord: { value: targetRkey } } : {}),
    });
    expect(res.status).toBe(200);
    return res.body.rkey as string;
  }

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('at-owner'));
    voter = await createTestUser(uniqueHandle('at-voter'));

    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('at-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(created.status).toBe(201);
    communityDid = created.body.did;

    const roles = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
    const modRoleRkey = roles.body.roles.find((r: any) => r.name === 'moderator').rkey;
    await xrpcAuthPost('net.openfederation.community.join', voter.accessJwt, { did: communityDid });
    await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: voter.did, roleRkey: modRoleRkey,
    });

    // No contest window: resolution applies in the request that decides it,
    // which is the path the separate commits used to live on.
    await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid,
      governanceModel: 'simple-majority',
      governanceConfig: { quorum: QUORUM, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0 },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolution is one commit', () => {
    it('writes the decision, the closed proposal and the change together', async () => {
      if (!plcAvailable) return;
      const rkey = await createProposal('atomic-1');

      const before = await query<{ rev: string }>(
        `SELECT rev FROM repo_roots WHERE did = $1`, [communityDid],
      );

      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
        communityDid, proposalRkey: rkey, vote: 'for',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(res.body.applied).toBe(true);

      const after = await query<{ rev: string }>(
        `SELECT rev FROM repo_roots WHERE did = $1`, [communityDid],
      );
      expect(after.rows[0].rev).not.toBe(before.rows[0].rev);

      // All three records carry the same commit revision — the mechanical
      // statement of "one commit", and the thing that used to be three.
      const revs = await query<{ rev: string; cid: string }>(
        `SELECT DISTINCT b.rev, b.cid FROM repo_blocks b
         JOIN records_index r ON r.cid = b.cid AND r.community_did = b.community_did
         WHERE b.community_did = $1
           AND ((r.collection = $2 AND r.rkey = $3)
             OR (r.collection = $4 AND r.rkey = $5)
             OR (r.collection = $6 AND r.record->>'proposalRkey' = $3))`,
        [communityDid, PROPOSAL_COLLECTION, rkey, TARGET_COLLECTION, 'atomic-1', DECISION_COLLECTION],
      );
      expect(revs.rows).toHaveLength(3);
      expect(new Set(revs.rows.map(r => r.rev)).size).toBe(1);
      expect(revs.rows[0].rev).toBe(after.rows[0].rev);
    });
  });

  describe('a crash during resolution leaves nothing behind', () => {
    it('rolls the decision, the close and the change back together', async () => {
      if (!plcAvailable) return;
      const rkey = await createProposal('atomic-crash');

      const rootBefore = await query<{ root_cid: string; rev: string }>(
        `SELECT root_cid, rev FROM repo_roots WHERE did = $1`, [communityDid],
      );

      // The fault goes in at the blockstore's commit, which is where a real
      // process death between the two old commits would have landed.
      const spy = failCommitsFor(communityDid);

      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
        communityDid, proposalRkey: rkey, vote: 'for',
      });
      expect(spy).toHaveBeenCalled();
      expect(res.status).toBe(500);

      // Nothing landed: no decision, no closed proposal, no change.
      expect(await decisionsFor(communityDid, rkey)).toHaveLength(0);
      expect(await inRepo(communityDid, TARGET_COLLECTION, 'atomic-crash')).toBeNull();

      const rootAfter = await query<{ root_cid: string; rev: string }>(
        `SELECT root_cid, rev FROM repo_roots WHERE did = $1`, [communityDid],
      );
      expect(rootAfter.rows[0].root_cid).toBe(rootBefore.rows[0].root_cid);

      // The proposal is exactly as it was: still open, so the next vote
      // resolves it. The old failure left it `approved` and unapplied forever.
      const record = await proposalRecord(communityDid, rkey);
      expect(record.status).toBe('open');
      expect(record.appliedAt).toBeUndefined();
    });

    // Swept across how many commits survive, because where the resolution dies
    // is exactly what used to decide whether it corrupted anything: under the
    // old ordering (decision, close, change) dying at the third commit left a
    // closed proposal whose change never happened, and nothing would revisit
    // it. One commit has no third commit to die at.
    it.each([1, 2, 3])(
      'never closes a proposal whose change was lost, with %i commit(s) surviving',
      async (survive) => {
        if (!plcAvailable) return;
        const target = `atomic-partial-${survive}`;
        const rkey = await createProposal(target);

        failCommitsAfterFirstFor(communityDid, survive);
        await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
          communityDid, proposalRkey: rkey, vote: 'for',
        });
        vi.restoreAllMocks();

        // The invariant, as the issue states it: a proposal must either still be
        // open/pending, or be closed with its change applied. Never closed
        // without it.
        const record = await proposalRecord(communityDid, rkey);
        const changed = await inRepo(communityDid, TARGET_COLLECTION, target);
        if (record.status === 'approved') {
          expect(changed).not.toBeNull();
        } else {
          expect(record.status).toBe('open');
          expect(changed).toBeNull();
        }
      },
    );

    it('resolves cleanly on the retry after that crash', async () => {
      if (!plcAvailable) return;
      const rkey = await createProposal('atomic-retry');

      failCommitsFor(communityDid);
      const failed = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
        communityDid, proposalRkey: rkey, vote: 'for',
      });
      expect(failed.status).toBe(500);
      vi.restoreAllMocks();

      const retried = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
        communityDid, proposalRkey: rkey, vote: 'for',
      });
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe('approved');
      expect(retried.body.applied).toBe(true);

      // Exactly one decision — the retry did not mint a second for the same
      // evidence — and the change is really there.
      expect(await decisionsFor(communityDid, rkey)).toHaveLength(1);
      const target = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'atomic-retry',
      });
      expect(target.status).toBe(200);
    });
  });

  describe('the lazy timelock application is one commit too', () => {
    let timelockedCommunityDid: string;
    let tlOwner: User;
    let tlVoter: User;

    beforeAll(async () => {
      if (!plcAvailable) return;
      tlOwner = await createTestUser(uniqueHandle('at2-owner'));
      tlVoter = await createTestUser(uniqueHandle('at2-voter'));

      const created = await xrpcAuthPost('net.openfederation.community.create', tlOwner.accessJwt, {
        handle: uniqueHandle('at2-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
      });
      timelockedCommunityDid = created.body.did;

      const roles = await xrpcGet('net.openfederation.community.listRoles', {
        communityDid: timelockedCommunityDid,
      });
      const modRoleRkey = roles.body.roles.find((r: any) => r.name === 'moderator').rkey;
      await xrpcAuthPost('net.openfederation.community.join', tlVoter.accessJwt, { did: timelockedCommunityDid });
      await xrpcAuthPost('net.openfederation.community.updateMember', tlOwner.accessJwt, {
        communityDid: timelockedCommunityDid, memberDid: tlVoter.did, roleRkey: modRoleRkey,
      });
      await xrpcAuthPost('net.openfederation.community.setGovernanceModel', tlOwner.accessJwt, {
        communityDid: timelockedCommunityDid,
        governanceModel: 'simple-majority',
        governanceConfig: { quorum: 2, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 6 },
      });
    });

    /** Pass a proposal and move its window into the past. */
    async function pendingDueProposal(targetRkey: string) {
      const created = await xrpcAuthPost('net.openfederation.community.createProposal', tlOwner.accessJwt, {
        communityDid: timelockedCommunityDid,
        targetCollection: TARGET_COLLECTION,
        targetRkey,
        action: 'write',
        proposedRecord: { value: targetRkey },
      });
      const rkey = created.body.rkey;
      const passed = await xrpcAuthPost('net.openfederation.community.voteOnProposal', tlVoter.accessJwt, {
        communityDid: timelockedCommunityDid, proposalRkey: rkey, vote: 'for',
      });
      expect(passed.body.status).toBe('pending-application');

      const record = await proposalRecord(timelockedCommunityDid, rkey);
      await putProposalRecord(
        new RepoEngine(timelockedCommunityDid),
        await getKeypairForDid(timelockedCommunityDid),
        timelockedCommunityDid,
        rkey,
        {
          ...record,
          resolvedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
          applyAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        },
      );
      return rkey;
    }

    it('closes the proposal and applies the change in one commit', async () => {
      if (!plcAvailable) return;
      const rkey = await pendingDueProposal('lazy-atomic');

      await xrpcGet('net.openfederation.community.getProposal', {
        communityDid: timelockedCommunityDid, rkey,
      });

      const record = await proposalRecord(timelockedCommunityDid, rkey);
      expect(record.status).toBe('approved');
      expect(record.appliedAt).toBeTruthy();

      const root = await query<{ rev: string }>(
        `SELECT rev FROM repo_roots WHERE did = $1`, [timelockedCommunityDid],
      );
      const revs = await query<{ rev: string }>(
        `SELECT DISTINCT b.rev FROM repo_blocks b
         JOIN records_index r ON r.cid = b.cid AND r.community_did = b.community_did
         WHERE b.community_did = $1
           AND ((r.collection = $2 AND r.rkey = $3) OR (r.collection = $4 AND r.rkey = $5))`,
        [timelockedCommunityDid, PROPOSAL_COLLECTION, rkey, TARGET_COLLECTION, 'lazy-atomic'],
      );
      expect(revs.rows).toHaveLength(1);
      expect(revs.rows[0].rev).toBe(root.rows[0].rev);
    });

    it('leaves the proposal pending, and applies it later, when the commit fails', async () => {
      if (!plcAvailable) return;
      const rkey = await pendingDueProposal('lazy-crash');

      failCommitsFor(timelockedCommunityDid);

      // The failure is contained — a stuck application must not turn a read of
      // the proposal into a 500 — so this succeeds and reports the old state.
      const read = await xrpcGet('net.openfederation.community.getProposal', {
        communityDid: timelockedCommunityDid, rkey,
      });
      expect(read.status).toBe(200);
      expect(read.body.status).toBe('pending-application');

      expect(await inRepo(timelockedCommunityDid, TARGET_COLLECTION, 'lazy-crash')).toBeNull();
      vi.restoreAllMocks();

      // Still pending, so the next interaction applies it. Under the old
      // separate-commit ordering this proposal would have been left `approved`
      // and unapplied, and nothing would have looked at it again.
      const again = await xrpcGet('net.openfederation.community.getProposal', {
        communityDid: timelockedCommunityDid, rkey,
      });
      expect(again.body.status).toBe('approved');
      const target = await xrpcGet('com.atproto.repo.getRecord', {
        repo: timelockedCommunityDid, collection: TARGET_COLLECTION, rkey: 'lazy-crash',
      });
      expect(target.status).toBe(200);
    });
  });

  describe('a delete proposal', () => {
    it('applies once and stays applicable on a retry', async () => {
      if (!plcAvailable) return;
      // Something to delete.
      await xrpcAuthPost('com.atproto.repo.putRecord', owner.accessJwt, {
        repo: communityDid, collection: TARGET_COLLECTION, rkey: 'atomic-del',
        record: { $type: TARGET_COLLECTION, value: 'doomed' },
      });
      expect((await inRepo(communityDid, TARGET_COLLECTION, 'atomic-del'))).not.toBeNull();

      const rkey = await createProposal('atomic-del', 'delete');
      const res = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
        communityDid, proposalRkey: rkey, vote: 'for',
      });
      expect(res.status).toBe(200);
      expect(await inRepo(communityDid, TARGET_COLLECTION, 'atomic-del')).toBeNull();

      // Idempotence is what makes a retry after a crash safe: a delete of a
      // record that is already gone is dropped rather than issued, because
      // `applyWrites` would reject it and the recovery path would fail on
      // exactly the case it exists for.
      const second = await createProposal('atomic-del', 'delete');
      const retry = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
        communityDid, proposalRkey: second, vote: 'for',
      });
      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe('approved');
    });
  });
});
