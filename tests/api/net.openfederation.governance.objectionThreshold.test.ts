/**
 * How many objectors it takes to hold a decided change — and what a settings
 * proposal actually writes.
 *
 * A hold is permanent: an `objected` proposal is never reopened, revoted, or
 * applied. So the number of objections it takes is a governance decision rather
 * than a constant. The default is 1 (exercised in
 * `net.openfederation.governance.timelock.test.ts` on a community that names no
 * threshold), which means one eligible member can stop a change the majority
 * voted for, indefinitely. `governanceConfig.objectionThreshold` is how a
 * community chooses otherwise.
 *
 * The same community also pins the settings-merge rule: a proposal that names
 * only the governance half of the settings record must not silently discard
 * everything else in it — which matters because since #198 the proposal route is
 * the *only* way to change the governance model under a voting model.
 *
 * A separate file from the timelock suite deliberately: both are request-heavy
 * and share the per-IP global limiter.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet, xrpcAuthPost,
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
const MINUTE = 60_000;

type User = { accessJwt: string; did: string; handle: string };

async function proposalRecord(communityDid: string, rkey: string) {
  const res = await query<{ record: any }>(
    `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
    [communityDid, PROPOSAL_COLLECTION, rkey],
  );
  return res.rows[0]?.record;
}

async function communitySettings(communityDid: string) {
  const res = await query<{ record: any }>(
    `SELECT record FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = 'self'`,
    [communityDid, SETTINGS_COLLECTION],
  );
  return res.rows[0]?.record;
}

/** Move the whole episode into the past through real signed commits. */
async function closeWindow(communityDid: string, rkey: string): Promise<void> {
  const anchor = Date.now();
  const resolvedAt = new Date(anchor - 90 * MINUTE).toISOString();
  const objectedAt = new Date(anchor - 60 * MINUTE).toISOString();
  const applyAt = new Date(anchor - 30 * MINUTE).toISOString();

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
}

describe('objectionThreshold decides how many objectors hold a change', () => {
  let plcAvailable: boolean;
  let owner: User;
  let voter1: User;
  let voter2: User;
  let did: string;

  const QUORUM = 3;
  const TIMELOCK_HOURS = 6;
  const THRESHOLD = 2;

  /** Take a fresh proposal to `pending-application`. */
  async function pass(targetRkey: string): Promise<string> {
    const created = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid: did,
      targetCollection: TARGET_COLLECTION,
      targetRkey,
      action: 'write',
      proposedRecord: { value: targetRkey },
    });
    expect(created.status).toBe(200);
    for (const voter of [voter1, voter2]) {
      const vote = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
        communityDid: did, proposalRkey: created.body.rkey, vote: 'for',
      });
      expect(vote.status).toBe(200);
    }
    return created.body.rkey as string;
  }

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('ot-owner'));
    voter1 = await createTestUser(uniqueHandle('ot-voter1'));
    voter2 = await createTestUser(uniqueHandle('ot-voter2'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('ot-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    expect(createRes.status).toBe(201);
    did = createRes.body.did;

    const rolesRes = await xrpcGet('net.openfederation.community.listRoles', { communityDid: did });
    const modRoleRkey = rolesRes.body.roles.find((r: any) => r.name === 'moderator').rkey;
    for (const member of [voter1, voter2]) {
      await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did });
      await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid: did, memberDid: member.did, roleRkey: modRoleRkey,
      });
    }

    // Set while the community is still benevolent-dictator — its last
    // ungoverned settings write.
    const modelRes = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid: did,
      governanceModel: 'simple-majority',
      governanceConfig: {
        quorum: QUORUM,
        voterRole: 'moderator',
        proposalTtlDays: 7,
        timelockHours: TIMELOCK_HOURS,
        objectionThreshold: THRESHOLD,
      },
    });
    expect(modelRes.status).toBe(200);
  });

  it('rejects a threshold that is not a positive integer', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid: did,
      governanceModel: 'simple-majority',
      governanceConfig: { quorum: QUORUM, voterRole: 'moderator', objectionThreshold: 0 },
    });
    // Validation precedes enforcement, so this is a shape error rather than a
    // governance refusal.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('does not hold the change on a single objection below the threshold', async () => {
    if (!plcAvailable) return;
    const rkey = await pass('thresh-under');

    const res = await xrpcAuthPost('net.openfederation.community.objectToProposal', voter1.accessJwt, {
      communityDid: did, proposalRkey: rkey,
    });
    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(true);
    expect(res.body.objectionCount).toBe(1);
    expect(res.body.objectionThreshold).toBe(THRESHOLD);
    // Below the bar: the proposal is untouched, not held.
    expect(res.body.status).toBe('pending-application');
    expect((await proposalRecord(did, rkey)).status).toBe('pending-application');

    await closeWindow(did, rkey);
    const read = await xrpcGet('net.openfederation.community.getProposal', { communityDid: did, rkey });
    expect(read.body.status).toBe('approved');
    expect((await xrpcGet('com.atproto.repo.getRecord', {
      repo: did, collection: TARGET_COLLECTION, rkey: 'thresh-under',
    })).status).toBe(200);
  });

  it('holds the change once the threshold is reached, and refuses a repeat objector', async () => {
    if (!plcAvailable) return;
    const rkey = await pass('thresh-met');

    const first = await xrpcAuthPost('net.openfederation.community.objectToProposal', voter1.accessJwt, {
      communityDid: did, proposalRkey: rkey,
    });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('pending-application');

    // One objector cannot reach the threshold alone by objecting twice.
    const again = await xrpcAuthPost('net.openfederation.community.objectToProposal', voter1.accessJwt, {
      communityDid: did, proposalRkey: rkey,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('AlreadyObjected');

    const second = await xrpcAuthPost('net.openfederation.community.objectToProposal', voter2.accessJwt, {
      communityDid: did, proposalRkey: rkey,
    });
    expect(second.status).toBe(200);
    expect(second.body.objectionCount).toBe(2);
    expect(second.body.status).toBe('objected');

    const proposal = await proposalRecord(did, rkey);
    expect(proposal.status).toBe('objected');
    expect(proposal.objections).toHaveLength(2);

    await closeWindow(did, rkey);
    const read = await xrpcGet('net.openfederation.community.getProposal', { communityDid: did, rkey });
    expect(read.body.status).toBe('objected');
    expect((await xrpcGet('com.atproto.repo.getRecord', {
      repo: did, collection: TARGET_COLLECTION, rkey: 'thresh-met',
    })).status).toBe(404);
  });

  /**
   * A settings proposal states the fields it changes. It used to replace the
   * whole record, so a governance-model proposal — now the mandatory route for
   * a model change under a voting model — silently discarded every other field
   * of the community's settings.
   */
  it('leaves unrelated settings fields alone when a governance proposal applies', async () => {
    if (!plcAvailable) return;

    const before = await communitySettings(did);
    await new RepoEngine(did).putRecord(
      await getKeypairForDid(did),
      SETTINGS_COLLECTION,
      'self',
      { ...before, joinPolicy: 'invite-only', description: 'keep me' },
    );

    const created = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid: did,
      targetCollection: SETTINGS_COLLECTION,
      targetRkey: 'self',
      action: 'write',
      // Only the governance half — exactly what a model-change proposal says.
      proposedRecord: {
        governanceModel: 'simple-majority',
        governanceConfig: {
          quorum: QUORUM,
          voterRole: 'moderator',
          proposalTtlDays: 14,
          timelockHours: TIMELOCK_HOURS,
          objectionThreshold: THRESHOLD,
        },
      },
    });
    expect(created.status).toBe(200);
    for (const voter of [voter1, voter2]) {
      const vote = await xrpcAuthPost('net.openfederation.community.voteOnProposal', voter.accessJwt, {
        communityDid: did, proposalRkey: created.body.rkey, vote: 'for',
      });
      expect(vote.status).toBe(200);
    }
    await closeWindow(did, created.body.rkey);
    const read = await xrpcGet('net.openfederation.community.getProposal', {
      communityDid: did, rkey: created.body.rkey,
    });
    expect(read.body.status).toBe('approved');

    const after = await communitySettings(did);
    // The proposal's fields landed...
    expect(after.governanceModel).toBe('simple-majority');
    expect(after.governanceConfig.proposalTtlDays).toBe(14);
    expect(after.governanceConfig.objectionThreshold).toBe(THRESHOLD);
    // ...and everything it never mentioned survived.
    expect(after.description).toBe('keep me');
    expect(after.joinPolicy).toBe('invite-only');
  });
});
