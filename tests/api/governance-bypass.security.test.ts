/**
 * Routes around a community's decision process that must stay closed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  api, xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { pseudonymElsewhere, openHere, exportedRepo, importRepo } from './migration-helpers.js';

type User = { accessJwt: string; did: string; handle: string };
const VOTE = 'net.openfederation.governance.vote';
const OBJECTION = 'net.openfederation.governance.objection';

describe('governance bypass', () => {
  let plc: boolean;
  let owner: User, member: User;
  let communityDid: string;
  let roles: Record<string, string>;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('govb-owner'));
    member = await createTestUser(uniqueHandle('govb-member'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('govb'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    communityDid = created.body.did;
    await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: communityDid });
    const listed = await xrpcAuthGet('net.openfederation.community.listRoles', owner.accessJwt, { communityDid });
    roles = Object.fromEntries(listed.body.roles.map((r: any) => [r.name, r.rkey]));
  });

  it('governance records cannot be hand-written into the community repo', async () => {
    if (!plc) return;
    for (const collection of [VOTE, OBJECTION, 'net.openfederation.governance.decision']) {
      const res = await xrpcAuthPost('com.atproto.repo.createRecord', owner.accessJwt, {
        repo: communityDid, collection,
        record: { $type: collection, community: communityDid, proposalRkey: 'x', vote: 'for', createdAt: new Date().toISOString() },
      });
      expect(res.status, collection).toBe(400);
      expect(res.body.error).toBe('UseDedicatedEndpoint');
    }
  });

  describe('once the community decides by vote', () => {
    beforeAll(async () => {
      if (!plc) return;
      const res = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
        communityDid, governanceModel: 'simple-majority',
        governanceConfig: { quorum: 1, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0 },
      });
      expect(res.status).toBe(200);
    });

    it('roles can no longer be created, changed or deleted without a proposal', async () => {
      if (!plc) return;
      const update = await xrpcAuthPost('net.openfederation.community.updateRole', owner.accessJwt, {
        communityDid, rkey: roles.member, permissions: ['community.member.read', 'community.governance.write'],
      });
      expect(update.status).toBe(403);
      expect(update.body.error).toBe('GovernanceDenied');
      const create = await xrpcAuthPost('net.openfederation.community.createRole', owner.accessJwt, {
        communityDid, name: 'stacked', permissions: ['community.governance.write'],
      });
      expect(create.status).toBe(403);
      const del = await xrpcAuthPost('net.openfederation.community.deleteRole', owner.accessJwt, {
        communityDid, rkey: roles.moderator,
      });
      expect(del.status).toBe(403);
    });
  });

  it('an arriving account cannot bring hand-written objections against a community it is not in', async () => {
    if (!plc) return;
    const p = await pseudonymElsewhere();
    const { accessJwt } = await openHere(p);
    const car = await exportedRepo(p.did, p.oldKey, [
      { collection: OBJECTION, rkey: '3kobjection001', record: { $type: OBJECTION, community: communityDid, proposalRkey: 'anything', createdAt: new Date().toISOString() } },
      { collection: VOTE, rkey: '3kvote0000001', record: { $type: VOTE, community: communityDid, proposalRkey: 'anything', vote: 'against', createdAt: new Date().toISOString() } },
      { collection: 'app.bsky.actor.profile', rkey: 'self', record: { $type: 'app.bsky.actor.profile', displayName: 'x' } },
    ]);
    const res = await importRepo(car, accessJwt);
    expect(res.status).toBe(200);
    const indexed = await query<{ collection: string }>(
      'SELECT collection FROM records_index WHERE community_did = $1', [p.did]);
    expect(indexed.rows.map(r => r.collection).sort()).toEqual(['app.bsky.actor.profile']);
  });

  it('an established account cannot roll its repository back by importing an old export', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('govb-roll'));
    const exported = await api.get('/xrpc/com.atproto.sync.getRepo').query({ did: user.did }).buffer(true)
      .parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(exported.status).toBe(200);
    const write = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
      repo: user.did, collection: 'net.openfederation.test.note', record: { $type: 'net.openfederation.test.note', text: 'later' },
    });
    expect(write.status).toBe(200);
    const before = (await query<{ root_cid: string }>('SELECT root_cid FROM repo_roots WHERE did = $1', [user.did])).rows[0].root_cid;

    await query(`UPDATE users SET status = 'deactivated' WHERE did = $1`, [user.did]);
    const res = await importRepo(new Uint8Array(exported.body), user.accessJwt);
    expect(res.status).toBe(409);
    const after = (await query<{ root_cid: string }>('SELECT root_cid FROM repo_roots WHERE did = $1', [user.did])).rows[0].root_cid;
    expect(after).toBe(before);
  });

  it('a delegation stops counting once the delegator is no longer a member', async () => {
    if (!plc) return;
    const delegate = await createTestUser(uniqueHandle('govb-delegate'));
    const delegator = await createTestUser(uniqueHandle('govb-delegator'));
    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('govb-del'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const did = created.body.did;
    const listed = await xrpcAuthGet('net.openfederation.community.listRoles', owner.accessJwt, { communityDid: did });
    const moderator = listed.body.roles.find((r: any) => r.name === 'moderator').rkey;
    for (const u of [delegate, delegator]) {
      await xrpcAuthPost('net.openfederation.community.join', u.accessJwt, { did });
      const up = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid: did, memberDid: u.did, roleRkey: moderator,
      });
      expect(up.status).toBe(200);
    }
    const model = await xrpcAuthPost('net.openfederation.community.setGovernanceModel', owner.accessJwt, {
      communityDid: did, governanceModel: 'simple-majority',
      governanceConfig: { quorum: 3, voterRole: 'moderator', proposalTtlDays: 7, timelockHours: 0 },
    });
    expect(model.status).toBe(200);
    const del = await xrpcAuthPost('net.openfederation.community.setDelegation', delegator.accessJwt, {
      communityDid: did, delegateDid: delegate.did,
    });
    expect(del.status).toBe(200);
    const removed = await xrpcAuthPost('net.openfederation.community.removeMember', owner.accessJwt, {
      did, memberDid: delegator.did,
    });
    expect(removed.status).toBe(200);

    const proposal = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid: did, targetCollection: 'net.openfederation.community.metadata', targetRkey: 'stale-delegation',
      action: 'write', proposedRecord: { displayName: 'x' },
    });
    expect(proposal.status).toBe(200);
    const vote = await xrpcAuthPost('net.openfederation.community.voteOnProposal', delegate.accessJwt, {
      communityDid: did, proposalRkey: proposal.body.rkey, vote: 'for',
    });
    expect(vote.status).toBe(200);

    const stored = await query<{ record: any }>(
      `SELECT record FROM records_index WHERE community_did = $1 AND collection = 'net.openfederation.community.proposal' AND rkey = $2`,
      [did, proposal.body.rkey]);
    expect(stored.rows[0].record.votesFor).toContain(delegate.did);
    expect(stored.rows[0].record.votesFor).not.toContain(delegator.did);
  });

  it('a PDS admin who is not a member cannot take part in a community decision', async () => {
    if (!plc) return;
    const { getAdminToken } = await import('./helpers.js');
    const adminToken = await getAdminToken();
    const propose = await xrpcAuthPost('net.openfederation.community.createProposal', adminToken, {
      communityDid, targetCollection: 'net.openfederation.community.metadata', targetRkey: 'admin-try',
      action: 'write', proposedRecord: { displayName: 'x' },
    });
    expect(propose.status).toBe(403);

    const proposal = await xrpcAuthPost('net.openfederation.community.createProposal', owner.accessJwt, {
      communityDid, targetCollection: 'net.openfederation.community.metadata', targetRkey: 'admin-vote',
      action: 'write', proposedRecord: { displayName: 'x' },
    });
    expect(proposal.status).toBe(200);
    const vote = await xrpcAuthPost('net.openfederation.community.voteOnProposal', adminToken, {
      communityDid, proposalRkey: proposal.body.rkey, vote: 'against',
    });
    expect(vote.status).toBe(403);
  });
});
