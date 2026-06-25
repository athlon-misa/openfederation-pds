import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost } from './helpers.js';

describe('net.openfederation.forum.createPost', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('member replies to a thread and receives uri+cid+rkey', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('fp-owner'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('fp-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;

    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'Topic',
    });
    expect(thread.status).toBe(200);

    const post = await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid,
      root: { uri: thread.body.uri, cid: thread.body.cid },
      text: 'first reply',
    });
    expect(post.status).toBe(200);
    expect(post.body.uri).toContain('net.openfederation.forum.post');
    expect(typeof post.body.cid).toBe('string');
    expect(typeof post.body.rkey).toBe('string');
  });

  it('returns 401 for unauthenticated request', async () => {
    if (!plc) return;
    const res = await xrpcAuthPost('net.openfederation.forum.createPost', '', {
      community: 'did:plc:fake',
      root: { uri: 'at://did:plc:fake/net.openfederation.forum.thread/abc', cid: 'fakecid' },
      text: 'hello',
    });
    expect(res.status).toBe(401);
  });
});
