import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcGet } from './helpers.js';

describe('forum reads', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('lists threads and returns a thread view', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('fr-owner'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('fr-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'Readable',
    });
    await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'hello',
    });

    const list = await xrpcGet('net.openfederation.forum.listThreads', { community: communityDid });
    expect(list.status).toBe(200);
    expect(list.body.threads.map((t: { uri: string }) => t.uri)).toContain(thread.body.uri);

    const view = await xrpcGet('net.openfederation.forum.getThread', { uri: thread.body.uri });
    expect(view.status).toBe(200);
    expect(view.body.thread.title).toBe('Readable');
    expect(view.body.posts).toHaveLength(1);
    expect(view.body.posts[0].record.text).toBe('hello');
  });
});
