import { describe, it, expect, beforeAll } from 'vitest';
import { createTestUser, isPLCAvailable, uniqueHandle, xrpcAuthPost, xrpcAuthGet, xrpcGet } from './helpers.js';

describe('net.openfederation.community.myCapabilities', () => {
  let plc: boolean;
  let owner: { accessJwt: string; did: string };
  let outsider: { accessJwt: string; did: string };
  let communityDid: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('caps-owner'));
    outsider = await createTestUser(uniqueHandle('caps-outsider'));
    const create = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('caps-comm'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    communityDid = create.body.did;
  });

  it('owner: isOwner true and permissions include community.forum.write', async () => {
    if (!plc) return;
    const res = await xrpcAuthGet('net.openfederation.community.myCapabilities', owner.accessJwt, { communityDid });
    expect(res.status).toBe(200);
    expect(res.body.isOwner).toBe(true);
    expect(res.body.permissions).toContain('community.forum.write');
  });

  it('non-member: isMember false, empty permissions', async () => {
    if (!plc) return;
    const res = await xrpcAuthGet('net.openfederation.community.myCapabilities', outsider.accessJwt, { communityDid });
    expect(res.status).toBe(200);
    expect(res.body.isMember).toBe(false);
    expect(res.body.isOwner).toBe(false);
    expect(res.body.permissions).toEqual([]);
  });

  it('rejects unauthenticated callers', async () => {
    if (!plc) return;
    const res = await xrpcGet('net.openfederation.community.myCapabilities', { communityDid });
    expect(res.status).toBe(401);
  });

  it('404s for an unknown community', async () => {
    if (!plc) return;
    const res = await xrpcAuthGet('net.openfederation.community.myCapabilities', owner.accessJwt, {
      communityDid: 'did:plc:doesnotexistcaps',
    });
    expect(res.status).toBe(404);
  });
});
