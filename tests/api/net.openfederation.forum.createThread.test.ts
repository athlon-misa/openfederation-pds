// tests/api/net.openfederation.forum.createThread.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcPost } from './helpers.js';

describe('net.openfederation.forum.createThread', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('rejects unauthenticated', async () => {
    const res = await xrpcPost('net.openfederation.forum.createThread', { community: 'did:plc:x', title: 't' });
    expect(res.status).toBe(401);
  });

  it('member creates a thread', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('ft-owner'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('ft-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    expect(create.status).toBe(201);
    const communityDid = create.body.did;

    const res = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'Welcome', tags: ['intro'],
    });
    expect(res.status).toBe(200);
    expect(res.body.uri).toContain('net.openfederation.forum.thread');
    expect(res.body.rkey).toBeTruthy();
  });

  it('rejects a non-member', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('ft-o2'));
    const outsider = await createTestUser(uniqueHandle('ft-out'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('ft-c2'), didMethod: 'plc', visibility: 'public', joinPolicy: 'approval',
    });
    const communityDid = create.body.did;
    const res = await xrpcAuthPost('net.openfederation.forum.createThread', outsider.accessJwt, {
      community: communityDid, title: 'nope',
    });
    expect(res.status).toBe(403);
  });
});
