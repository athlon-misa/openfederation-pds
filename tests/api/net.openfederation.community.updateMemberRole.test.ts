import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcGet, xrpcAuthPost, xrpcAuthGet,
  createTestUser, getAdminToken, isPLCAvailable, uniqueHandle,
} from './helpers.js';

describe('updateMemberRole', () => {
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
      communityDid,
    });
  });

  it('should reject unauthenticated', async () => {
    const res = await xrpcPost('net.openfederation.community.updateMemberRole', {
      communityDid: 'did:plc:test', memberDid: 'did:plc:test2', role: 'moderator',
    });
    expect(res.status).toBe(401);
  });

  it('should reject invalid role', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMemberRole', owner.accessJwt, {
      communityDid, memberDid: member.did, role: 'owner',
    });
    expect(res.status).toBe(400);
  });

  it('should reject non-owner', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMemberRole', member.accessJwt, {
      communityDid, memberDid: member.did, role: 'moderator',
    });
    expect(res.status).toBe(403);
  });

  it('should promote a member to moderator', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMemberRole', owner.accessJwt, {
      communityDid, memberDid: member.did, role: 'moderator',
    });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('moderator');
  });

  it('should demote a moderator to member', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMemberRole', owner.accessJwt, {
      communityDid, memberDid: member.did, role: 'member',
    });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('member');
  });

  it('should reject changing owner role', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMemberRole', owner.accessJwt, {
      communityDid, memberDid: owner.did, role: 'member',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CannotChangeOwner');
  });

  it('should return 404 for non-member', async () => {
    if (!plcAvailable) return;
    const res = await xrpcAuthPost('net.openfederation.community.updateMemberRole', owner.accessJwt, {
      communityDid, memberDid: 'did:plc:nonexistent', role: 'moderator',
    });
    expect(res.status).toBe(404);
  });
});
