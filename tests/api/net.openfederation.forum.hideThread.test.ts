import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcGet } from './helpers.js';

describe('net.openfederation.forum.hideThread', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('owner hides a thread: it vanishes from public listThreads and getThread 404s; unhide restores it', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('ht-owner'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('ht-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'to be hidden',
    });

    const hide = await xrpcAuthPost('net.openfederation.forum.hideThread', owner.accessJwt, {
      uri: thread.body.uri, hidden: true,
    });
    expect(hide.status).toBe(200);
    expect(hide.body.success).toBe(true);

    const list = await xrpcGet('net.openfederation.forum.listThreads', { community: communityDid });
    expect(list.body.threads.map((t: { uri: string }) => t.uri)).not.toContain(thread.body.uri);

    const view = await xrpcGet('net.openfederation.forum.getThread', { uri: thread.body.uri });
    expect(view.status).toBe(404);

    const unhide = await xrpcAuthPost('net.openfederation.forum.hideThread', owner.accessJwt, {
      uri: thread.body.uri, hidden: false,
    });
    expect(unhide.status).toBe(200);

    const restored = await xrpcGet('net.openfederation.forum.getThread', { uri: thread.body.uri });
    expect(restored.status).toBe(200);
  });

  it('rejects a caller without community.forum.write', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('ht-owner2'));
    const outsider = await createTestUser(uniqueHandle('ht-outsider'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('ht-comm2'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: create.body.did, title: 'stays visible',
    });

    const hide = await xrpcAuthPost('net.openfederation.forum.hideThread', outsider.accessJwt, {
      uri: thread.body.uri, hidden: true,
    });
    expect(hide.status).toBe(403);
  });

  it('404s for an unknown thread uri', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('ht-nouser'));
    const res = await xrpcAuthPost('net.openfederation.forum.hideThread', user.accessJwt, {
      uri: 'at://did:plc:nobody/net.openfederation.forum.thread/none', hidden: true,
    });
    expect(res.status).toBe(404);
  });
});
