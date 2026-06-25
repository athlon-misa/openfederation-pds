import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcGet } from './helpers.js';

describe('net.openfederation.forum.deletePost', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('author deletes own post and post_count decrements', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('fd-owner'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('fd-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, { community: communityDid, title: 'd' });
    const post = await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'bye',
    });

    const del = await xrpcAuthPost('net.openfederation.forum.deletePost', owner.accessJwt, { rkey: post.body.rkey });
    expect(del.status).toBe(200);

    const view = await xrpcGet('net.openfederation.forum.getThread', { uri: thread.body.uri });
    expect(view.body.thread.postCount).toBe(0);
    expect(view.body.posts).toHaveLength(0);
  });
});
