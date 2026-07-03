import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost } from './helpers.js';

describe('legacy moderator role can moderate the forum', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('a member assigned the moderator role can hide a post', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('modrole-owner'));
    const mod = await createTestUser(uniqueHandle('modrole-mod'));

    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('modrole-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;

    await xrpcAuthPost('net.openfederation.community.join', mod.accessJwt, { did: communityDid });
    const promote = await xrpcAuthPost('net.openfederation.community.updateMember', owner.accessJwt, {
      communityDid, memberDid: mod.did, role: 'moderator',
    });
    expect(promote.status).toBe(200);

    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'mod-role test',
    });
    const post = await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'to hide',
    });

    const hide = await xrpcAuthPost('net.openfederation.forum.hidePost', mod.accessJwt, {
      uri: post.body.uri, hidden: true,
    });
    expect(hide.status).toBe(200);
  });

  it('a plain member still cannot hide a post', async () => {
    if (!plc) return;
    const owner = await createTestUser(uniqueHandle('modrole-owner2'));
    const member = await createTestUser(uniqueHandle('modrole-member'));

    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('modrole-comm2'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    const communityDid = create.body.did;
    await xrpcAuthPost('net.openfederation.community.join', member.accessJwt, { did: communityDid });

    const thread = await xrpcAuthPost('net.openfederation.forum.createThread', owner.accessJwt, {
      community: communityDid, title: 'member test',
    });
    const post = await xrpcAuthPost('net.openfederation.forum.createPost', owner.accessJwt, {
      community: communityDid, root: { uri: thread.body.uri, cid: thread.body.cid }, text: 'stay put',
    });

    const hide = await xrpcAuthPost('net.openfederation.forum.hidePost', member.accessJwt, {
      uri: post.body.uri, hidden: true,
    });
    expect(hide.status).toBe(403);
  });
});
