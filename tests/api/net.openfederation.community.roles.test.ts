import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

describe('Community Roles', () => {
  let plcAvailable: boolean;
  let owner: { accessJwt: string; did: string; handle: string };
  let member: { accessJwt: string; did: string; handle: string };
  let communityDid: string;
  let customRoleRkey: string;
  let memberRoleRkey: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    owner = await createTestUser(uniqueHandle('role-owner'));
    member = await createTestUser(uniqueHandle('role-member'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('role-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    communityDid = createRes.body.did;

    await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { communityDid });
  });

  describe('listRoles', () => {
    it('should list default roles for a new community', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
      expect(res.status).toBe(200);
      expect(res.body.roles.length).toBe(3);
      const names = res.body.roles.map((r: any) => r.name).sort();
      expect(names).toEqual(['member', 'moderator', 'owner']);

      memberRoleRkey = res.body.roles.find((r: any) => r.name === 'member').rkey;
    });

    it('should show member counts', async () => {
      if (!plcAvailable) return;
      const res = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
      const ownerRole = res.body.roles.find((r: any) => r.name === 'owner');
      expect(ownerRole.memberCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('createRole', () => {
    it('should reject unauthenticated', async () => {
      const res = await xrpcPost('net.openfederation.community.createRole', {
        communityDid: 'did:plc:test', name: 'coach', permissions: ['community.member.read'],
      });
      expect(res.status).toBe(401);
    });

    it('should reject non-owner', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.createRole', member.accessJwt, {
        communityDid, name: 'coach', permissions: ['community.member.read'],
      });
      expect(res.status).toBe(403);
    });

    it('should create a custom role', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.createRole', owner.accessJwt, {
        communityDid, name: 'coach', description: 'Team coach',
        permissions: ['community.member.read', 'community.attestation.write'],
      });
      expect(res.status).toBe(200);
      expect(res.body.rkey).toBeTruthy();
      customRoleRkey = res.body.rkey;
    });

    it('should reject duplicate name', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.createRole', owner.accessJwt, {
        communityDid, name: 'coach', permissions: ['community.member.read'],
      });
      expect(res.status).toBe(409);
    });

    it('should reject invalid permissions', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.createRole', owner.accessJwt, {
        communityDid, name: 'invalid', permissions: ['not.a.real.permission'],
      });
      expect(res.status).toBe(400);
    });
  });

  describe('updateRole', () => {
    it('should update a role', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.updateRole', owner.accessJwt, {
        communityDid, rkey: customRoleRkey,
        permissions: ['community.member.read', 'community.attestation.write', 'community.attestation.delete'],
      });
      expect(res.status).toBe(200);
    });

    it('should prevent owner lockout', async () => {
      if (!plcAvailable) return;
      const rolesRes = await xrpcGet('net.openfederation.community.listRoles', { communityDid });
      const ownerRkey = rolesRes.body.roles.find((r: any) => r.name === 'owner').rkey;

      const res = await xrpcAuthPost('net.openfederation.community.updateRole', owner.accessJwt, {
        communityDid, rkey: ownerRkey, permissions: ['community.member.read'],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('OwnerLockout');
    });
  });

  describe('updateMemberRole with roleRkey', () => {
    it('should assign a member to a custom role', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.updateMemberRole', owner.accessJwt, {
        communityDid, memberDid: member.did, roleRkey: customRoleRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('coach');
      expect(res.body.roleRkey).toBe(customRoleRkey);
    });
  });

  describe('deleteRole', () => {
    it('should reject deleting a role with members', async () => {
      if (!plcAvailable) return;
      const res = await xrpcAuthPost('net.openfederation.community.deleteRole', owner.accessJwt, {
        communityDid, rkey: customRoleRkey,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('RoleInUse');
    });

    it('should delete a role after reassigning members', async () => {
      if (!plcAvailable) return;
      await xrpcAuthPost('net.openfederation.community.updateMemberRole', owner.accessJwt, {
        communityDid, memberDid: member.did, roleRkey: memberRoleRkey,
      });

      const res = await xrpcAuthPost('net.openfederation.community.deleteRole', owner.accessJwt, {
        communityDid, rkey: customRoleRkey,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
