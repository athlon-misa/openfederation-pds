import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcGet } from './helpers.js';

describe('net.openfederation.forum.hidePost', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('owner hides a post; it disappears from the thread view', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('fh-owner'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('fh-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, { community: communityDid, title: 'h' });
    const post = await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'spam',
    });

    const hide = await xrpcAuthPost('net.openfederation.forum.hidePost', owner.accessJwt, { uri: post.body.uri, hidden: true });
    expect(hide.status).toBe(200);

    const view = await xrpcGet('net.openfederation.forum.getThread', { uri: thread.body.uri });
    expect(view.body.posts).toHaveLength(0);
  });
});
