/**
 * A suspension or takedown has to mean something: a suspended community is
 * frozen, a taken-down repo is not served, and neither can be undone except
 * by the moderation endpoints, which put things back the way they were.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet, xrpcAuthPost, xrpcAuthGet, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { markCommunityMoved } from '../../src/community/migration.js';

type User = { accessJwt: string; did: string; handle: string };

async function newCommunity(owner: User): Promise<string> {
  const res = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
    handle: uniqueHandle('modst'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
  });
  expect(res.status).toBe(201);
  return res.body.did;
}
const setCommunityStatus = (did: string, status: string) =>
  query('UPDATE communities SET status = $2 WHERE did = $1', [did, status]);
const communityStatus = async (did: string) =>
  (await query<{ status: string }>('SELECT status FROM communities WHERE did = $1', [did])).rows[0]?.status;

describe('moderation status enforcement', () => {
  let plc: boolean;
  let adminToken: string;
  let owner: User, member: User, outsider: User;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    adminToken = await getAdminToken();
    owner = await createTestUser(uniqueHandle('modst-owner'));
    member = await createTestUser(uniqueHandle('modst-member'));
    outsider = await createTestUser(uniqueHandle('modst-out'));
  });

  describe('a suspended community is frozen', () => {
    let did: string;
    beforeAll(async () => {
      if (!plc) return;
      did = await newCommunity(owner);
      await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did });
      await setCommunityStatus(did, 'suspended');
    });

    it('nobody can join', async () => {
      if (!plc) return;
      const res = await xrpcAuthPost('net.openfederation.community.join', outsider.accessJwt, { did });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('CommunitySuspended');
    });

    it('the owner cannot write records through the generic repo endpoint', async () => {
      if (!plc) return;
      const res = await xrpcAuthPost('com.atproto.repo.createRecord', owner.accessJwt, {
        repo: did, collection: 'net.openfederation.test.note', record: { $type: 'net.openfederation.test.note', text: 'x' },
      });
      expect(res.status).toBe(403);
    });

    it('the owner cannot change roles, settings or membership', async () => {
      if (!plc) return;
      const update = await xrpcAuthPost('net.openfederation.community.update', owner.accessJwt, { did, displayName: 'renamed' });
      expect(update.status).toBe(403);
      const role = await xrpcAuthPost('net.openfederation.community.createRole', owner.accessJwt, {
        communityDid: did, name: 'x', permissions: [],
      });
      expect(role.status).toBe(403);
      const upd = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid: did, memberDid: member.did, role: 'moderator',
      });
      expect(upd.status).toBe(403);
      const leave = await xrpcAuthPost('net.openfederation.community.leave', member.accessJwt, { did });
      expect(leave.status).toBe(403);
    });

    it('the owner cannot delete it out from under the moderators', async () => {
      if (!plc) return;
      const res = await xrpcAuthPost('net.openfederation.community.delete', owner.accessJwt, { did });
      expect(res.status).toBe(403);
      expect(await communityStatus(did)).toBe('suspended');
    });

    it('cannot be flipped to moved, which would let it come back active', async () => {
      if (!plc) return;
      expect(await markCommunityMoved(did, 'https://elsewhere.example')).toBe(false);
      expect(await communityStatus(did)).toBe('suspended');
    });
  });

  describe('a taken-down community is not served', () => {
    let did: string;
    beforeAll(async () => {
      if (!plc) return;
      did = await newCommunity(owner);
      await setCommunityStatus(did, 'takendown');
    });

    it('refuses repo and community reads to the public', async () => {
      if (!plc) return;
      const repo = await xrpcGet('com.atproto.sync.getRepo', { did });
      expect(repo.status).not.toBe(200);
      const list = await xrpcGet('com.atproto.repo.listRecords', { repo: did, collection: 'net.openfederation.community.member' });
      expect(list.status).not.toBe(200);
      const roles = await xrpcGet('net.openfederation.community.listRoles', { communityDid: did });
      expect(roles.status).toBe(410);
    });

    it('still serves a PDS admin', async () => {
      if (!plc) return;
      const list = await xrpcAuthGet('com.atproto.repo.listRecords', adminToken, {
        repo: did, collection: 'net.openfederation.community.member',
      });
      expect(list.status).toBe(200);
    });

    it('cannot be flipped to moved', async () => {
      if (!plc) return;
      expect(await markCommunityMoved(did, 'https://elsewhere.example')).toBe(false);
      expect(await communityStatus(did)).toBe('takendown');
    });
  });

  it('an active community can still be marked moved', async () => {
    if (!plc) return;
    const did = await newCommunity(owner);
    expect(await markCommunityMoved(did, 'https://elsewhere.example')).toBe(true);
    expect(await communityStatus(did)).toBe('moved');
  });

  it('unsuspending a community puts back the status it had', async () => {
    if (!plc) return;
    const did = await newCommunity(owner);
    await setCommunityStatus(did, 'moved');
    const s = await xrpcAuthPost('net.openfederation.community.suspend', adminToken, { did, reason: 'test' });
    expect(s.status).toBe(200);
    const u = await xrpcAuthPost('net.openfederation.community.unsuspend', adminToken, { did });
    expect(u.status).toBe(200);
    expect(await communityStatus(did)).toBe('moved');
  });

  describe('accounts', () => {
    const userStatus = async (did: string) =>
      (await query<{ status: string }>('SELECT status FROM users WHERE did = $1', [did])).rows[0]?.status;

    it('a taken-down account repo is not served to the public', async () => {
      if (!plc) return;
      const user = await createTestUser(uniqueHandle('modst-td'));
      await query(`UPDATE users SET status = 'takendown' WHERE did = $1`, [user.did]);
      const repo = await xrpcGet('com.atproto.sync.getRepo', { did: user.did });
      expect(repo.status).toBe(400);
      expect(repo.body.error).toBe('RepoTakendown');
      const list = await xrpcGet('com.atproto.repo.listRecords', { repo: user.did, collection: 'app.bsky.actor.profile' });
      expect(list.status).toBe(400);
      const asAdmin = await xrpcAuthGet('com.atproto.repo.listRecords', adminToken, { repo: user.did, collection: 'app.bsky.actor.profile' });
      expect(asAdmin.status).toBe(200);
    });

    it('unsuspending an account puts back the status it had', async () => {
      if (!plc) return;
      const user = await createTestUser(uniqueHandle('modst-deact'));
      await query(`UPDATE users SET status = 'deactivated' WHERE did = $1`, [user.did]);
      const s = await xrpcAuthPost('com.atproto.admin.updateSubjectStatus', adminToken, {
        subject: { $type: 'com.atproto.admin.defs#repoRef', did: user.did }, deactivated: { applied: true, ref: 'test' },
      });
      expect(s.status).toBe(200);
      expect(await userStatus(user.did)).toBe('suspended');
      const u = await xrpcAuthPost('com.atproto.admin.updateSubjectStatus', adminToken, {
        subject: { $type: 'com.atproto.admin.defs#repoRef', did: user.did }, deactivated: { applied: false },
      });
      expect(u.status).toBe(200);
      expect(await userStatus(user.did)).toBe('deactivated');
    });
  });
});
