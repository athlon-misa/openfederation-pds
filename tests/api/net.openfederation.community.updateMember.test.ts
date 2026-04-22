import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcAuthPost, xrpcAuthGet,
  createTestUser, getAdminToken, isPLCAvailable, uniqueHandle,
} from './helpers.js';

describe('updateMember', () => {
  let plcAvailable: boolean;
  let adminToken: string;
  let owner: { accessJwt: string; did: string; handle: string };
  let member: { accessJwt: string; did: string; handle: string };
  let communityDid: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    adminToken = await getAdminToken();
    owner = await createTestUser(uniqueHandle('role-owner'));
    member = await createTestUser(uniqueHandle('role-member'));

    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('role-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    communityDid = createRes.body.did;

    await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, {
      did: communityDid,
    });
  });

  it('should reject unauthenticated', async () => {
    const res = await xrpcPost('net.openfederation.community.updateMember', {
      communityDid: 'did:plc:test', memberDid: 'did:plc:test2', role: 'moderator',
    });
    expect(res.status).toBe(401);
  });

  it('should reject assigning owner role', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: member.did, role: 'owner',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/owner/i);
  });

  it('should reject when no updatable field is supplied', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: member.did,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least one of/i);
  });

  it('should reject non-owner', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', member.accessJwt, {
      communityDid, memberDid: member.did, role: 'moderator',
    });
    expect(res.status).toBe(403);
  });

  it('should promote a member to moderator', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: member.did, role: 'moderator',
    });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('moderator');
  });

  it('should demote a moderator to member', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: member.did, role: 'member',
    });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('member');
  });

  it('should refuse to change the owner (CannotChangeOwner)', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: owner.did, role: 'member',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CannotChangeOwner');
  });

  it('should return 404 for non-member', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: 'did:plc:nonexistent', role: 'moderator',
    });
    expect(res.status).toBe(404);
  });

  describe('semantic fields (issue #50)', () => {
    it('sets kind/tags/attributes and listMembers returns them', async () => {
      if (!plcAvailable) return;
      const updateRes = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid,
        memberDid: member.did,
        kind: 'player',
        tags: ['captain', 'forward'],
        attributes: { jerseyNumber: 9, position: 'ST' },
      });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.kind).toBe('player');
      expect(updateRes.body.tags).toEqual(['captain', 'forward']);
      expect(updateRes.body.attributes).toEqual({ jerseyNumber: 9, position: 'ST' });

      const listRes = await xrpcAuthGet('net.openfederation.community.listMembers', owner.accessJwt, {
        did: communityDid,
      });
      expect(listRes.status).toBe(200);
      const m = listRes.body.members.find((x: any) => x.did === member.did);
      expect(m.kind).toBe('player');
      expect(m.tags).toEqual(['captain', 'forward']);
      expect(m.attributes).toEqual({ jerseyNumber: 9, position: 'ST' });
    });

    it('partial update preserves fields not supplied', async () => {
      if (!plcAvailable) return;
      const updateRes = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid,
        memberDid: member.did,
        kind: 'staff',
      });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.kind).toBe('staff');
      // tags and attributes should still be present from the previous call
      expect(updateRes.body.tags).toEqual(['captain', 'forward']);
      expect(updateRes.body.attributes).toEqual({ jerseyNumber: 9, position: 'ST' });
    });

    it('null clears a field', async () => {
      if (!plcAvailable) return;
      const updateRes = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid,
        memberDid: member.did,
        tags: null,
        attributes: null,
      });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.tags).toBeUndefined();
      expect(updateRes.body.attributes).toBeUndefined();
      expect(updateRes.body.kind).toBe('staff'); // not cleared
    });

    it('rejects oversized attributes', async () => {
      if (!plcAvailable) return;
      const huge = { blob: 'x'.repeat(5000) };
      const res = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid,
        memberDid: member.did,
        attributes: huge,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('PayloadTooLarge');
    });

    it('rejects too many tags', async () => {
      if (!plcAvailable) return;
      const tooMany = Array.from({ length: 25 }, (_, i) => `t${i}`);
      const res = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
        communityDid,
        memberDid: member.did,
        tags: tooMany,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('join with semantic fields', () => {
    it('passes kind/tags/attributes through to the member record', async () => {
      if (!plcAvailable) return;
      const joiner = await createTestUser(uniqueHandle('joiner'));
      const joinRes = await xrpcAuthPost('net.openfederation.community.join', joiner.accessJwt, {
        did: communityDid,
        kind: 'fan',
        tags: ['season-ticket-holder'],
        attributes: { supporterSince: 2019 },
      });
      expect(joinRes.status).toBe(200);

      const listRes = await xrpcAuthGet('net.openfederation.community.listMembers', owner.accessJwt, {
        did: communityDid,
      });
      const m = listRes.body.members.find((x: any) => x.did === joiner.did);
      expect(m).toBeDefined();
      expect(m.kind).toBe('fan');
      expect(m.tags).toEqual(['season-ticket-holder']);
      expect(m.attributes).toEqual({ supporterSince: 2019 });
    });

    it('rejects join with oversized attributes', async () => {
      if (!plcAvailable) return;
      const joiner = await createTestUser(uniqueHandle('bigjoiner'));
      const res = await xrpcAuthPost('net.openfederation.community.join', joiner.accessJwt, {
        did: communityDid,
        attributes: { blob: 'x'.repeat(5000) },
      });
      expect(res.status).toBe(400);
    });
  });
});
