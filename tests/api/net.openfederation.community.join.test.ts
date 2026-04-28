import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestUser,
  isPLCAvailable,
  uniqueHandle,
  xrpcAuthPost,
  xrpcPost,
  xrpcAuthGet,
} from './helpers.js';

describe('net.openfederation.community.join', () => {
  let plcAvailable: boolean;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await xrpcPost('net.openfederation.community.join', { did: 'did:plc:example' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('preserves AlreadyMember as a semantic error code', async () => {
    if (!plcAvailable) return;

    const owner = await createTestUser(uniqueHandle('join-owner'));
    const member = await createTestUser(uniqueHandle('join-member'));
    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('join-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    expect(createRes.status).toBe(201);

    const communityDid = createRes.body.did;
    const firstJoin = await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, {
      did: communityDid,
    });
    expect(firstJoin.status).toBe(200);
    expect(firstJoin.body.status).toBe('joined');

    const secondJoin = await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, {
      did: communityDid,
    });
    expect(secondJoin.status).toBe(409);
    expect(secondJoin.body.error).toBe('AlreadyMember');
    expect(secondJoin.body.message).toMatch(/already a member/i);
  });

  it('preserves AlreadyRequested as a semantic error code', async () => {
    if (!plcAvailable) return;

    const owner = await createTestUser(uniqueHandle('request-owner'));
    const requester = await createTestUser(uniqueHandle('request-member'));
    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('request-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'approval',
    });
    expect(createRes.status).toBe(201);

    const communityDid = createRes.body.did;
    const firstJoin = await xrpcAuthPost('net.openfederation.community.join', requester.accessJwt, {
      did: communityDid,
    });
    expect(firstJoin.status).toBe(200);
    expect(firstJoin.body.status).toBe('pending');

    const secondJoin = await xrpcAuthPost('net.openfederation.community.join', requester.accessJwt, {
      did: communityDid,
    });
    expect(secondJoin.status).toBe(409);
    expect(secondJoin.body.error).toBe('AlreadyRequested');
    expect(secondJoin.body.message).toMatch(/pending join request/i);
  });

  it('approves a pending join request and preserves AlreadyResolved', async () => {
    if (!plcAvailable) return;

    const owner = await createTestUser(uniqueHandle('approve-owner'));
    const requester = await createTestUser(uniqueHandle('approve-member'));
    const createRes = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('approve-comm'),
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'approval',
    });
    expect(createRes.status).toBe(201);

    const communityDid = createRes.body.did;
    const joinRes = await xrpcAuthPost('net.openfederation.community.join', requester.accessJwt, {
      did: communityDid,
    });
    expect(joinRes.status).toBe(200);
    expect(joinRes.body.status).toBe('pending');

    const listRes = await xrpcAuthGet('net.openfederation.community.listJoinRequests', owner.accessJwt, {
      did: communityDid,
    });
    expect(listRes.status).toBe(200);
    expect(listRes.body.requests).toHaveLength(1);
    const requestId = listRes.body.requests[0].id;

    const approveRes = await xrpcAuthPost('net.openfederation.community.resolveJoinRequest', owner.accessJwt, {
      requestId,
      action: 'approve',
    });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('approved');

    const getRes = await xrpcAuthGet('net.openfederation.community.get', requester.accessJwt, {
      did: communityDid,
    });
    expect(getRes.status).toBe(200);
    expect(getRes.body.isMember).toBe(true);
    expect(getRes.body.myMembership.status).toBe('member');

    const secondResolve = await xrpcAuthPost('net.openfederation.community.resolveJoinRequest', owner.accessJwt, {
      requestId,
      action: 'approve',
    });
    expect(secondResolve.status).toBe(400);
    expect(secondResolve.body.error).toBe('AlreadyResolved');
  });
});
