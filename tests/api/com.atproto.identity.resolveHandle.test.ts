import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcGet, xrpcAuthPost,
  createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

const HANDLE_SUFFIX = process.env.HANDLE_SUFFIX || '.openfederation.net';

describe('com.atproto.identity.resolveHandle (issue #52)', () => {
  let plcAvailable: boolean;
  let user: { accessJwt: string; did: string; handle: string };
  let communityDid: string;
  let communityHandle: string;

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;

    user = await createTestUser(uniqueHandle('resolve-user'));

    communityHandle = uniqueHandle('resolve-comm');
    const createRes = await xrpcAuthPost('net.openfederation.community.create', user.accessJwt, {
      handle: communityHandle,
      didMethod: 'plc',
      visibility: 'public',
      joinPolicy: 'open',
    });
    communityDid = createRes.body.did;
  });

  it('returns 400 when handle param is missing', async () => {
    const res = await xrpcGet('com.atproto.identity.resolveHandle');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('resolves a bare user handle to its DID', async () => {
    if (!plcAvailable) return;
    const res = await xrpcGet('com.atproto.identity.resolveHandle', { handle: user.handle });
    expect(res.status).toBe(200);
    expect(res.body.did).toBe(user.did);
  });

  it('resolves a suffixed user handle to the same DID', async () => {
    if (!plcAvailable) return;
    const res = await xrpcGet('com.atproto.identity.resolveHandle', {
      handle: `${user.handle}${HANDLE_SUFFIX}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.did).toBe(user.did);
  });

  it('normalizes casing before lookup', async () => {
    if (!plcAvailable) return;
    const res = await xrpcGet('com.atproto.identity.resolveHandle', {
      handle: user.handle.toUpperCase(),
    });
    expect(res.status).toBe(200);
    expect(res.body.did).toBe(user.did);
  });

  it('resolves a community handle to its DID', async () => {
    if (!plcAvailable) return;
    const res = await xrpcGet('com.atproto.identity.resolveHandle', { handle: communityHandle });
    expect(res.status).toBe(200);
    expect(res.body.did).toBe(communityDid);
  });

  it('returns HandleNotFound for an unknown handle', async () => {
    const res = await xrpcGet('com.atproto.identity.resolveHandle', {
      handle: 'definitely-not-registered-xyz-' + Date.now(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('HandleNotFound');
  });

  it('is public (works without authentication)', async () => {
    if (!plcAvailable) return;
    // xrpcGet sends no Authorization header
    const res = await xrpcGet('com.atproto.identity.resolveHandle', { handle: user.handle });
    expect(res.status).toBe(200);
  });

  it('rejects undeclared query params on public (unauthenticated) requests', async () => {
    // Bug #63: lexicon validation was gated on hasCredential, so unauthenticated
    // requests could pass undeclared fields that the handler silently ignores.
    const res = await xrpcGet('com.atproto.identity.resolveHandle', {
      handle: 'some-valid-looking-handle',
      undeclaredParam: 'injected',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
    expect(res.body.message).toMatch(/not declared by the lexicon/i);
  });
});
