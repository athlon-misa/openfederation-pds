import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, getAdminToken } from './helpers.js';

describe('generic write path rejects forum collections', () => {
  let plc: boolean;
  let adminToken: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    adminToken = await getAdminToken();
  });

  it('rejects createRecord for forum.post', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('guard'));
    const res = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
      repo: user.did,
      collection: 'net.openfederation.forum.post',
      record: { text: 'bypass attempt' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UseDedicatedEndpoint');
  });

  it('rejects putRecord for forum.thread', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('guard'));
    const res = await xrpcAuthPost('com.atproto.repo.putRecord', user.accessJwt, {
      repo: user.did,
      collection: 'net.openfederation.forum.thread',
      rkey: 'test123',
      record: { title: 'bypass attempt' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UseDedicatedEndpoint');
  });

  it('rejects deleteRecord for calendar.event', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('guard'));
    const res = await xrpcAuthPost('com.atproto.repo.deleteRecord', user.accessJwt, {
      repo: user.did,
      collection: 'community.lexicon.calendar.event',
      rkey: 'test123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UseDedicatedEndpoint');
  });

  it('rejects createRecord for calendar.rsvp', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('guard'));
    const res = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
      repo: user.did,
      collection: 'community.lexicon.calendar.rsvp',
      record: { status: 'going' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UseDedicatedEndpoint');
  });

  it('allows createRecord for regular collections', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('guard'));
    const res = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
      repo: user.did,
      collection: 'app.bsky.feed.post',
      record: { text: 'allowed post' },
    });
    // Should not be 400 with UseDedicatedEndpoint error (may be other errors like auth/governance)
    expect(res.status).not.toBe(400);
    expect(res.body.error).not.toBe('UseDedicatedEndpoint');
  });
});
