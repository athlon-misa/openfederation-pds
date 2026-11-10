/**
 * Holding `community.member.write` lets you manage members; it must not let
 * you hand out (or take for yourself) more power than you hold.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';

type User = { accessJwt: string; did: string; handle: string };

describe('community role escalation', () => {
  let plc: boolean;
  let owner: User, mod: User, member: User;
  let communityDid: string;
  let roles: Record<string, string>;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('esc-owner'));
    mod = await createTestUser(uniqueHandle('esc-mod'));
    member = await createTestUser(uniqueHandle('esc-member'));

    const created = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('esc-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    communityDid = created.body.did;
    for (const u of [mod, member]) {
      await xrpcAuthPost('net.openfederation.community.join', u.accessJwt, { did: communityDid });
    }
    const listed = await xrpcAuthGet('net.openfederation.community.listRoles', owner.accessJwt, { communityDid });
    roles = Object.fromEntries(listed.body.roles.map((r: any) => [r.name, r.rkey]));
    const promoted = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: mod.did, roleRkey: roles.moderator,
    });
    expect(promoted.status).toBe(200);
  });

  it('a moderator cannot give themselves the owner role by rkey', async () => {
    if (!plc) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', mod.accessJwt, {
      communityDid, memberDid: mod.did, roleRkey: roles.owner,
    });
    expect(res.status).toBe(403);
    const caps = await xrpcAuthGet('net.openfederation.community.myCapabilities', mod.accessJwt, { communityDid });
    expect(caps.body.permissions).not.toContain('community.role.write');
  });

  it('a moderator cannot give another member a role stronger than their own', async () => {
    if (!plc) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', mod.accessJwt, {
      communityDid, memberDid: member.did, roleRkey: roles.owner,
    });
    expect(res.status).toBe(403);
  });

  it('a moderator can still assign roles within their own permissions', async () => {
    if (!plc) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', mod.accessJwt, {
      communityDid, memberDid: member.did, roleRkey: roles.moderator,
    });
    expect(res.status).toBe(200);
    const back = await xrpcAuthPost('net.openfederation.community.updateMember', mod.accessJwt, {
      communityDid, memberDid: member.did, roleRkey: roles.member,
    });
    expect(back.status).toBe(200);
  });

  it('the owner can still assign any role', async () => {
    if (!plc) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: member.did, roleRkey: roles.moderator,
    });
    expect(res.status).toBe(200);
  });

  describe('a community whose creator is not recorded (it moved here)', () => {
    beforeAll(async () => {
      if (!plc) return;
      await query('UPDATE communities SET created_by = NULL WHERE did = $1', [communityDid]);
    });

    it("still refuses to change the owner's role", async () => {
      if (!plc) return;
      const res = await xrpcAuthPost('net.openfederation.community.updateMember', mod.accessJwt, {
        communityDid, memberDid: owner.did, roleRkey: roles.member,
      });
      expect(res.status).toBe(403);
    });

    it('still refuses to let the owner leave', async () => {
      if (!plc) return;
      const res = await xrpcAuthPost('net.openfederation.community.leave', owner.accessJwt, { did: communityDid });
      expect(res.status).toBe(403);
    });

    it('still lets the owner remove a member, and never the owner', async () => {
      if (!plc) return;
      const self = await xrpcAuthPost('net.openfederation.community.removeMember', owner.accessJwt, {
        did: communityDid, memberDid: owner.did,
      });
      expect(self.status).toBe(403);
      const res = await xrpcAuthPost('net.openfederation.community.removeMember', owner.accessJwt, {
        did: communityDid, memberDid: member.did,
      });
      expect(res.status).toBe(200);
    });
  });

  it('the owner role cannot be stripped of its required permissions by renaming it first', async () => {
    if (!plc) return;
    await xrpcAuthPost('net.openfederation.community.updateRole', owner.accessJwt, {
      communityDid, rkey: roles.owner, name: 'founder',
    });
    const res = await xrpcAuthPost('net.openfederation.community.updateRole', owner.accessJwt, {
      communityDid, rkey: roles.owner, permissions: ['community.member.read'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('OwnerLockout');
  });
});
