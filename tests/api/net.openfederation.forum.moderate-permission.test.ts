import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcAuthGet } from './helpers.js';

describe('community.forum.moderate is a distinct permission from community.forum.write', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('a plain member (default role) has forum.write but NOT forum.moderate, and cannot hide a post', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('fm-owner'));
    const member = await createTestUser(uniqueHandle('fm-member'));

    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('fm-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: communityDid });

    const caps = await xrpcAuthGet('net.openfederation.community.myCapabilities', member.accessJwt, { communityDid });
    expect(caps.body.permissions).toContain('community.forum.write');
    expect(caps.body.permissions).not.toContain('community.forum.moderate');

    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'member cannot hide this',
    });
    const post = await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'stays visible',
    });

    const hide = await xrpcAuthPost('net.openfederation.forum.hidePost', member.accessJwt, {
      uri: post.body.uri, hidden: true,
    });
    expect(hide.status).toBe(403);

    const hideThread = await xrpcAuthPost('net.openfederation.forum.hideThread', member.accessJwt, {
      uri: thread.body.uri, hidden: true,
    });
    expect(hideThread.status).toBe(403);
  });

  it('a moderator-role member has both forum.write and forum.moderate, and CAN hide a post', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('fm-owner2'));
    const mod = await createTestUser(uniqueHandle('fm-mod'));

    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('fm-comm2'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    await xrpcAuthPost('net.openfederation.community.join', mod.accessJwt, { did: communityDid });
    await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: mod.did, role: 'moderator',
    });

    const caps = await xrpcAuthGet('net.openfederation.community.myCapabilities', mod.accessJwt, { communityDid });
    expect(caps.body.permissions).toContain('community.forum.write');
    expect(caps.body.permissions).toContain('community.forum.moderate');

    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'moderator can hide this',
    });
    const post = await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'hideable',
    });

    const hide = await xrpcAuthPost('net.openfederation.forum.hidePost', mod.accessJwt, {
      uri: post.body.uri, hidden: true,
    });
    expect(hide.status).toBe(200);
  });

  it('the owner (always hasAllPermissions) can still hide/unhide regardless of the new permission', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('fm-owner3'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('fm-comm3'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'owner test',
    });
    const post = await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'owner-hideable',
    });
    const hide = await xrpcAuthPost('net.openfederation.forum.hidePost', owner.accessJwt, {
      uri: post.body.uri, hidden: true,
    });
    expect(hide.status).toBe(200);
  });
});
