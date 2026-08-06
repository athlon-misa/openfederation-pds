/**
 * Timelock and objection window for passed proposals (#197).
 *
 * A passed proposal no longer applies in the request that resolved it: it
 * enters `pending-application` and waits out the community's contest window,
 * during which an eligible member can publish a signed objection that holds the
 * change. What is exercised here is the whole state machine, on real signed
 * records:
 *
 *   pending → (window elapses, nothing objected) → approved, change applied
 *   pending → (eligible objection inside window)  → held, change withheld
 *   pending → (ineligible or late objection)      → unaffected, change applied
 *
 * Since #199 a hold is `objection-override` — the same hold, with one round of
 * re-review attached — and what happens inside that round belongs to the
 * override suite rather than here.
 *
 * Time is never waited on. The window is closed by rewriting the proposal's
 * `applyAt` through the community's own key — a real signed commit, exactly the
 * shape the record would have had if the clock had reached it — so every
 * assertion is deterministic.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet, xrpcAuthGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { RepoEngine } from '../../src/repo/repo-engine.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { query } from '../../src/db/client.js';
import { putProposalRecord } from '../../src/governance/proposal-resolution.js';

const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';
const OBJECTION_COLLECTION = 'net.openfederation.governance.objection';
const TARGET_COLLECTION = 'app.example.governed';
const SETTINGS_COLLECTION = 'net.openfederation.community.settings';

async function communitySettings(communityDid: string) {
  const res = await query<{ record: any }>(
    `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = 'self'`,
    [communityDid, SETTINGS_COLLECTION],
  );
  return res.rows[0]?.record;
}

type User = { accessJwt: string; did: string; handle: string };

async function proposalRecord(communityDid: string, rkey: string) {
  const res = await query<{ record: any }>(
    `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, PROPOSAL_COLLECTION, rkey],
  );
  return res.rows[0]?.record;
}

/**
 * Close the contest window by moving `applyAt` into the past, through a real
 * signed commit by the community. No sleeping, and the repo stays honest.
 *
 * The whole episode is moved wholesale into the past — resolved 90 minutes ago,
 * window closed 30 minutes ago, any objection raised 60 minutes ago, each
 * re-signed by the key that produced it — rather than the window alone being
 * dragged backwards across objections that are still timestamped "now". Every
 * offset is fixed, so no assertion's outcome depends on how much real time
 * elapses between here and the read that follows.
 */
const MINUTE = 60_000;

async function closeWindow(communityDid: string, rkey: string): Promise<string> {
  const anchor = Date.now();
  const resolvedAt = new Date(anchor - 90 * MINUTE).toISOString();
  const objectedAt = new Date(anchor - 60 * MINUTE).toISOString();
  const applyAt = new Date(anchor - 30 * MINUTE).toISOString();

  // Objections keep their place inside the window they were raised in, so
  // closing the window models time passing rather than retroactively making a
  // timely objection late — a different scenario, pinned by the rules tests.
  const raised = await query<{ repo_did: string; rkey: string; record: any }>(
    `SELECT community_did AS repo_did, rkey, record FROM records_index
     WHERE collection = $1 AND record->>'community' = $2 AND record->>'proposalRkey' = $3`,
    [OBJECTION_COLLECTION, communityDid, rkey],
  );
  for (const row of raised.rows) {
    await new RepoEngine(row.repo_did).putRecord(
      await getKeypairForDid(row.repo_did),
      OBJECTION_COLLECTION,
      row.rkey,
      { ...row.record, createdAt: objectedAt },
    );
  }

  const record = await proposalRecord(communityDid, rkey);
  await putProposalRecord(
    new RepoEngine(communityDid),
    await getKeypairForDid(communityDid),
    communityDid,
    rkey,
    { ...record, resolvedAt, applyAt },
  );
  return applyAt;
}

async function targetRecord(communityDid: string, rkey: string) {
  return xrpcGet('com.atproto.repo.getRecord', {
    repo: communityDid, collection: TARGET_COLLECTION, rkey,
  });
}

async function auditEntries(action: string, communityDid: string, rkey: string) {
  const res = await query<{ meta: any }>(
    `SELECT meta FROM audit_log
     WHERE action = $1 AND target_id = $2 AND meta->>'rkey' = $3
     ORDER BY id ASC`,
    [action, communityDid, rkey],
  );
  return res.rows.map(r => r.meta);
}

describe('Governance timelock and objection window', () => {
  let plcAvailable: boolean;
  let owner: User;
  let voter1: User;
  let voter2: User;
  /** Joined, but without community.governance.write — could not have voted. */
  let outsider: User;
  let communityDid: string;

  const QUORUM = 3;
  const TIMELOCK_HOURS = 6;

  async function createProposal(targetRkey: string) {
    const res = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid,
      targetCollection: TARGET_COLLECTION,
      targetRkey,
      action: 'write',
      proposedRecord: { value: targetRkey },
    });
    expect(res.status).toBe(200);
    return res.body as { uri: string; cid: string; rkey: string };
  }

  /** Take a fresh proposal all the way to `pending-application`. */
  async function passProposal(targetRkey: string) {
    const created = await createProposal(targetRkey);
    const first = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter1.accessJwt, {
      communityDid, proposalRkey: created.rkey, vote: 'for',
    });
    expect(first.status).toBe(200);
    const second = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter2.accessJwt, {
      communityDid, proposalRkey: created.rkey, vote: 'for',
    });
    expect(second.status).toBe(200);
    return { ...created, resolution: second.body };
  }

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('tl-owner'));
    voter1 = await createTestUser(uniqueHandle('tl-voter1'));
    voter2 = await createTestUser(uniqueHandle('tl-voter2'));
    outsider = await createTestUser(uniqueHandle('tl-outsider'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('tl-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    expect(createRes.status).toBe(201);
    communityDid = createRes.body.did;

    const rolesRes = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
    const modRoleRkey = rolesRes.body.roles.find((r: any) => r.name === 'moderator').rkey;

    for (const member of [voter1, voter2]) {
      await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: communityDid });
      await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid, memberDid: member.did, roleRkey: modRoleRkey,
      });
    }
    // Joins as a plain member: no governance permission, so no standing to vote
    // and — by the same rule — none to object.
    await xrpcAuthPost('net.openfederation.community.join', outsider.accessJwt, { did: communityDid });

    const modelRes = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid,
      governanceModel: 'simple-majority',
      governanceConfig: {
        quorum: QUORUM, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: TIMELOCK_HOURS,
      },
    });
    expect(modelRes.status).toBe(200);
  });

  describe('a passed proposal pends instead of applying', () => {
    let rkey: string;
    let resolution: any;

    it('resolves into pending-application with the window on the record', async () => {
      if (!plcAvailable) return;
      const passed = await passProposal('pend-1');
      rkey = passed.rkey;
      resolution = passed.resolution;

      expect(resolution.status).toBe('pending-application');
      expect(resolution.pendingApplication).toBe(true);
      expect(resolution.applied).toBeUndefined();
      // Decided, not deferred: nothing about the evidence is in doubt.
      expect(resolution.resolutionDeferred).toBeUndefined();

      const proposal = await proposalRecord(communityDid, rkey);
      expect(proposal.status).toBe('pending-application');
      expect(proposal.decision?.uri).toBeTruthy();
      const window = new Date(proposal.applyAt).getTime() - new Date(proposal.resolvedAt).getTime();
      expect(window).toBe(TIMELOCK_HOURS * 60 * 60 * 1000);
      expect(resolution.applyAt).toBe(proposal.applyAt);
    });

    it('has decided the proposal — the decision record exists and says approved', async () => {
      if (!plcAvailable) return;
      const proposal = await proposalRecord(communityDid, rkey);
      const decisionRes = await xrpcGet('com.atproto.repo.getRecord', {
        repo: communityDid,
        collection: 'net.openfederation.governance.decision',
        rkey: proposal.decision.rkey,
      });
      expect(decisionRes.status).toBe(200);
      expect(decisionRes.body.value.outcome).toBe('approved');
      expect(decisionRes.body.cid).toBe(proposal.decision.cid);
    });

    it('has not touched the target record', async () => {
      if (!plcAvailable) return;
      const applied = await targetRecord(communityDid, 'pend-1');
      expect(applied.status).toBe(404);
    });

    it('audits the pending application with its window and decision', async () => {
      if (!plcAvailable) return;
      const [meta] = await auditEntries('community.proposal.pendingApplication', communityDid, rkey);
      expect(meta).toBeTruthy();
      expect(meta.applyAt).toBeTruthy();
      expect(meta.decisionUri).toBeTruthy();
      // Nothing was applied, so nothing claims to have been.
      expect(await auditEntries('community.proposal.approve', communityDid, rkey)).toEqual([]);
    });
  });

  describe('an unobjected proposal applies when the window elapses', () => {
    let rkey: string;

    it('applies on the next read once applyAt has passed', async () => {
      if (!plcAvailable) return;
      const passed = await passProposal('apply-1');
      rkey = passed.rkey;
      expect((await targetRecord(communityDid, 'apply-1')).status).toBe(404);

      await closeWindow(communityDid, rkey);

      // Lazy evaluation on access: the read itself makes the transition.
      const read = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey });
      expect(read.status).toBe(200);
      expect(read.body.status).toBe('approved');
      expect(read.body.appliedAt).toBeTruthy();

      const applied = await targetRecord(communityDid, 'apply-1');
      expect(applied.status).toBe(200);
      expect(applied.body.value.value).toBe('apply-1');
    });

    it('audits the application as timelocked, citing the decision', async () => {
      if (!plcAvailable) return;
      const [meta] = await auditEntries('community.proposal.apply', communityDid, rkey);
      expect(meta).toBeTruthy();
      expect(meta.timelocked).toBe(true);
      expect(meta.targetRkey).toBe('apply-1');
      expect(meta.decisionUri).toBeTruthy();
    });

    it('is idempotent — a second read applies nothing further', async () => {
      if (!plcAvailable) return;
      const read = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey });
      expect(read.body.status).toBe('approved');
      expect(await auditEntries('community.proposal.apply', communityDid, rkey)).toHaveLength(1);
    });

    it('also applies through listProposals, which sweeps the community', async () => {
      if (!plcAvailable) return;
      const passed = await passProposal('apply-2');
      await closeWindow(communityDid, passed.rkey);

      const list = await xrpcGet('net.openfederation.community.listProposals', { communityDid });
      expect(list.status).toBe(200);
      const listed = list.body.proposals.find((p: any) => p.rkey === passed.rkey);
      expect(listed.status).toBe('approved');
      expect((await targetRecord(communityDid, 'apply-2')).status).toBe(200);
    });
  });

  // A hold is `objection-override` rather than `objected` since #199: the same
  // hold, now with one round of re-review attached. `objected` remains the state
  // for a community that opts out with `objectionReview: 'none'`; that path and
  // the round itself are covered in the override suite.
  const HELD_STATUS = 'objection-override';

  describe('a signed objection inside the window holds the change', () => {
    let rkey: string;
    let objection: { uri: string; cid: string; rkey: string };

    it('accepts an objection from a member who could have voted', async () => {
      if (!plcAvailable) return;
      const passed = await passProposal('held-1');
      rkey = passed.rkey;

      const res = await xrpcAuthPost('net.openfederation.community.objectToProposal', voter1.accessJwt, {
        communityDid, proposalRkey: rkey, reason: 'needs more discussion',
      });
      expect(res.status).toBe(200);
      expect(res.body.recorded).toBe(true);
      expect(res.body.status).toBe(HELD_STATUS);
      objection = res.body.objection;
      expect(objection.uri.startsWith(`at://${voter1.did}/${OBJECTION_COLLECTION}/`)).toBe(true);
    });

    it('is a real signed record in the objector own repo, visible through the repo API', async () => {
      if (!plcAvailable) return;
      const direct = await xrpcGet('com.atproto.repo.getRecord', {
        repo: voter1.did, collection: OBJECTION_COLLECTION, rkey: objection.rkey,
      });
      expect(direct.status).toBe(200);
      expect(direct.body.cid).toBe(objection.cid);

      const proposal = await proposalRecord(communityDid, rkey);
      const value = direct.body.value;
      expect(value.$type).toBe(OBJECTION_COLLECTION);
      expect(value.community).toBe(communityDid);
      expect(value.proposal.uri).toBe(`at://${communityDid}/${PROPOSAL_COLLECTION}/${rkey}`);
      expect(value.proposalRkey).toBe(rkey);
      expect(value.decision.uri).toBe(proposal.decision.uri);
      expect(value.decision.cid).toBe(proposal.decision.cid);
      expect(value.reason).toBe('needs more discussion');
      expect(value.createdAt < proposal.applyAt).toBe(true);

      const listed = await xrpcAuthGet('com.atproto.repo.listRecords', voter1.accessJwt, {
        repo: voter1.did, collection: OBJECTION_COLLECTION,
      });
      expect(listed.status).toBe(200);
      expect(listed.body.records.some((r: any) => r.uri === objection.uri)).toBe(true);
    });

    it('holds the change past the end of the window', async () => {
      if (!plcAvailable) return;
      const proposal = await proposalRecord(communityDid, rkey);
      expect(proposal.status).toBe(HELD_STATUS);
      expect(proposal.objections).toHaveLength(1);
      expect(proposal.objections[0].objector).toBe(voter1.did);
      expect(proposal.objections[0].record.cid).toBe(objection.cid);

      await closeWindow(communityDid, rkey);
      const read = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey });
      expect(read.body.status).toBe(HELD_STATUS);
      expect((await targetRecord(communityDid, 'held-1')).status).toBe(404);
      expect(await auditEntries('community.proposal.apply', communityDid, rkey)).toEqual([]);
    });

    it('cites the objection in the audit log', async () => {
      if (!plcAvailable) return;
      const [meta] = await auditEntries('community.proposal.objection', communityDid, rkey);
      expect(meta.objector).toBe(voter1.did);
      expect(meta.objectionUri).toBe(objection.uri);
      expect(meta.objectionCid).toBe(objection.cid);
      expect(meta.held).toBe(true);
    });

    it('refuses a second objection to an already held proposal', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.objectToProposal', voter2.accessJwt, {
        communityDid, proposalRkey: rkey,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ObjectionWindowClosed');
    });

    it('holds a change even if the proposal record never recorded the objection', async () => {
      if (!plcAvailable) return;
      // A crash between writing the objection record and rewriting the proposal
      // would leave the proposal still `pending-application`. The hold has to
      // survive that, because it rests on the signed record and not the cache.
      const passed = await passProposal('held-2');
      const res = await xrpcAuthPost('net.openfederation.community.objectToProposal', voter2.accessJwt, {
        communityDid, proposalRkey: passed.rkey,
      });
      expect(res.status).toBe(200);

      const { objections: _dropped, ...withoutCache } = await proposalRecord(communityDid, passed.rkey);
      await putProposalRecord(
        new RepoEngine(communityDid),
        await getKeypairForDid(communityDid),
        communityDid,
        passed.rkey,
        { ...withoutCache, status: 'pending-application' },
      );
      await closeWindow(communityDid, passed.rkey);

      const read = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey: passed.rkey });
      expect(read.body.status).toBe(HELD_STATUS);
      expect((await targetRecord(communityDid, 'held-2')).status).toBe(404);
    });
  });

  describe('ineligible and late objections do not hold the change', () => {
    it('refuses an objection from a member without governance standing', async () => {
      if (!plcAvailable) return;
      const passed = await passProposal('ineligible-1');

      const res = await xrpcAuthPost('net.openfederation.community.objectToProposal', outsider.accessJwt, {
        communityDid, proposalRkey: passed.rkey,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');

      // No record was written, and the change goes through on schedule.
      const listed = await xrpcAuthGet('com.atproto.repo.listRecords', outsider.accessJwt, {
        repo: outsider.did, collection: OBJECTION_COLLECTION,
      });
      expect((listed.body.records ?? []).length).toBe(0);

      await closeWindow(communityDid, passed.rkey);
      const read = await xrpcGet('net.openfederation.community.getProposal', { communityDid, rkey: passed.rkey });
      expect(read.body.status).toBe('approved');
      expect((await targetRecord(communityDid, 'ineligible-1')).status).toBe(200);
    });

    it('refuses an objection raised after the window closed, and applies the change', async () => {
      if (!plcAvailable) return;
      const passed = await passProposal('late-1');
      await closeWindow(communityDid, passed.rkey);

      const res = await xrpcAuthPost('net.openfederation.community.objectToProposal', voter1.accessJwt, {
        communityDid, proposalRkey: passed.rkey,
      });
      // The handler applies due proposals before it looks: the window is gone
      // and so is the state that could have been objected to.
      expect(res.status).toBe(400);
      expect(['ProposalNotPending', 'ObjectionWindowClosed']).toContain(res.body.error);

      const proposal = await proposalRecord(communityDid, passed.rkey);
      expect(proposal.status).toBe('approved');
      expect((await targetRecord(communityDid, 'late-1')).status).toBe(200);
    });

    it('refuses an objection to a proposal that is still open', async () => {
      if (!plcAvailable) return;
      const created = await createProposal('open-1');
      const res = await xrpcAuthPost('net.openfederation.community.objectToProposal', voter1.accessJwt, {
        communityDid, proposalRkey: created.rkey,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('ProposalNotPending');
    });

    it('refuses a hand-written objection record in the objector own repo', async () => {
      if (!plcAvailable) return;
      // Eligibility and timeliness are established by the endpoint. A record
      // written directly would assert them instead.
      const res = await xrpcAuthPost('com.atproto.repo.createRecord', outsider.accessJwt, {
        repo: outsider.did,
        collection: OBJECTION_COLLECTION,
        record: { community: communityDid, proposalRkey: 'whatever', createdAt: new Date().toISOString() },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UseDedicatedEndpoint');
    });
  });

  describe('one unappliable proposal does not block the rest', () => {
    it('sweeps past a proposal whose application throws, and audits it', async () => {
      if (!plcAvailable) return;
      // Both pending before either window closes, so a single sweep sees them
      // in `rkey ASC` order — the poisoned one first.
      const poisoned = await passProposal('poison-1');
      const healthy = await passProposal('after-poison');
      expect(poisoned.rkey < healthy.rkey).toBe(true);

      // An unwritable target: applying this proposal throws inside the sweep.
      const record = await proposalRecord(communityDid, poisoned.rkey);
      await putProposalRecord(
        new RepoEngine(communityDid),
        await getKeypairForDid(communityDid),
        communityDid,
        poisoned.rkey,
        { ...record, targetCollection: '' },
      );

      await closeWindow(communityDid, poisoned.rkey);
      await closeWindow(communityDid, healthy.rkey);

      // One sweep, covering both.
      const list = await xrpcGet('net.openfederation.community.listProposals', { communityDid });
      expect(list.status).toBe(200);

      // Nothing was written for the poisoned proposal...
      expect((await targetRecord(communityDid, 'poison-1')).status).toBe(404);
      // ...and the failure is recorded rather than only logged.
      const [failure] = await auditEntries('community.proposal.applyFailed', communityDid, poisoned.rkey);
      expect(failure).toBeTruthy();
      expect(failure.reason).toBeTruthy();

      // The proposal after it still applied — the sweep did not abort.
      expect((await targetRecord(communityDid, 'after-poison')).status).toBe(200);
      const healthyRecord = await proposalRecord(communityDid, healthy.rkey);
      expect(healthyRecord.status).toBe('approved');
    });
  });

  describe('a community may waive the window, but only by saying so', () => {
    it('applies immediately when timelockHours is 0', async () => {
      if (!plcAvailable) return;

      // Waiving the window is a change to the community's protected settings
      // record, so under a voting model it goes through a proposal like any
      // other (#198) — there is no operator switch for it.
      const direct = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid,
        governanceModel: 'simple-majority',
        governanceConfig: {
          quorum: QUORUM, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0,
        },
      });
      expect(direct.status).toBe(403);
      expect(direct.body.requiresProposal).toBe(true);

      const settings = await communitySettings(communityDid);
      const waive = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
        communityDid,
        targetCollection: SETTINGS_COLLECTION,
        targetRkey: 'self',
        action: 'write',
        proposedRecord: {
          ...settings,
          governanceConfig: { ...settings.governanceConfig, timelockHours: 0 },
        },
      });
      expect(waive.status).toBe(200);
      for (const voter of [voter1, voter2]) {
        const vote = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
          communityDid, proposalRkey: waive.body.rkey, vote: 'for',
        });
        expect(vote.status).toBe(200);
      }
      // The waiver is itself decided under the old window, so it waits it out.
      await closeWindow(communityDid, waive.body.rkey);
      const applied = await xrpcGet('net.openfederation.community.getProposal', {
        communityDid, rkey: waive.body.rkey,
      });
      expect(applied.body.status).toBe('approved');
      expect((await communitySettings(communityDid)).governanceConfig.timelockHours).toBe(0);

      const passed = await passProposal('instant-1');
      expect(passed.resolution.status).toBe('approved');
      expect(passed.resolution.applied).toBe(true);
      expect(passed.resolution.pendingApplication).toBeUndefined();
      expect((await targetRecord(communityDid, 'instant-1')).status).toBe(200);
    });

    it('rejects a malformed timelock setting rather than guessing', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid,
        governanceModel: 'simple-majority',
        governanceConfig: {
          quorum: QUORUM, voterRole: 'moderator', timelockHours: -1,
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });
  });
});
