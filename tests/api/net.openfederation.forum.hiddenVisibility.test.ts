import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcAuthGet, xrpcGet } from './helpers.js';

describe('forum hidden visibility for moderators', () => {
  let plc: boolean;
  let owner: { accessJwt: string; did: string };
  let outsider: { accessJwt: string; did: string };
  let communityDid: string;
  let threadUri: string;
  let hiddenPostUri: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('hv-owner'));
    outsider = await createTestUser(uniqueHandle('hv-outsider'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('hv-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    communityDid = create.body.did;
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'visibility test',
    });
    threadUri = thread.body.uri;
    const post = await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'hide me',
    });
    hiddenPostUri = post.body.uri;
    await xrpcAuthPost('net.openfederation.forum.hidePost', owner.accessJwt, { uri: hiddenPostUri, hidden: true });
  });

  it('owner (moderator) sees the hidden post with hidden: true in getThread', async () => {
    if (!plc) return;
    const view = await xrpcAuthGet('net.openfederation.forum.getThread', owner.accessJwt, { uri: threadUri });
    expect(view.status).toBe(200);
    const hiddenPost = view.body.posts.find((p: { uri: string }) => p.uri === hiddenPostUri);
    expect(hiddenPost).toBeDefined();
    expect(hiddenPost.hidden).toBe(true);
  });

  it('an authenticated non-moderator does NOT see the hidden post', async () => {
    if (!plc) return;
    const view = await xrpcAuthGet('net.openfederation.forum.getThread', outsider.accessJwt, { uri: threadUri });
    expect(view.status).toBe(200);
    expect(view.body.posts.map((p: { uri: string }) => p.uri)).not.toContain(hiddenPostUri);
  });

  it('anonymous callers do NOT see the hidden post and visible content carries hidden: false', async () => {
    if (!plc) return;
    const view = await xrpcGet('net.openfederation.forum.getThread', { uri: threadUri });
    expect(view.status).toBe(200);
    expect(view.body.thread.hidden).toBe(false);
    expect(view.body.posts.map((p: { uri: string }) => p.uri)).not.toContain(hiddenPostUri);
  });

  it('owner can getThread a hidden thread (hidden: true); others 404', async () => {
    if (!plc) return;
    await xrpcAuthPost('net.openfederation.forum.hideThread', owner.accessJwt, { uri: threadUri, hidden: true });

    const ownerView = await xrpcAuthGet('net.openfederation.forum.getThread', owner.accessJwt, { uri: threadUri });
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.thread.hidden).toBe(true);

    const outsiderView = await xrpcAuthGet('net.openfederation.forum.getThread', outsider.accessJwt, { uri: threadUri });
    expect(outsiderView.status).toBe(404);

    const anonView = await xrpcGet('net.openfederation.forum.getThread', { uri: threadUri });
    expect(anonView.status).toBe(404);

    await xrpcAuthPost('net.openfederation.forum.hideThread', owner.accessJwt, { uri: threadUri, hidden: false });
  });

  it('listThreads includes hidden threads (hidden: true) for the owner only', async () => {
    if (!plc) return;
    await xrpcAuthPost('net.openfederation.forum.hideThread', owner.accessJwt, { uri: threadUri, hidden: true });

    const ownerList = await xrpcAuthGet('net.openfederation.forum.listThreads', owner.accessJwt, { community: communityDid });
    const ownerRow = ownerList.body.threads.find((t: { uri: string }) => t.uri === threadUri);
    expect(ownerRow).toBeDefined();
    expect(ownerRow.hidden).toBe(true);

    const anonList = await xrpcGet('net.openfederation.forum.listThreads', { community: communityDid });
    expect(anonList.body.threads.map((t: { uri: string }) => t.uri)).not.toContain(threadUri);

    const outsiderList = await xrpcAuthGet('net.openfederation.forum.listThreads', outsider.accessJwt, { community: communityDid });
    expect(outsiderList.body.threads.map((t: { uri: string }) => t.uri)).not.toContain(threadUri);

    await xrpcAuthPost('net.openfederation.forum.hideThread', owner.accessJwt, { uri: threadUri, hidden: false });
  });
});
