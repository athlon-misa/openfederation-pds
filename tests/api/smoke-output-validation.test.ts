/**
 * Smoke tests: every XRPC handler produces a response that passes the lexicon
 * output validator when called through the full Express middleware stack.
 *
 * Acceptance criterion (issue #65):
 *   Reverting 19b28f0 (createdAt: c.created_at instead of .toISOString())
 *   causes these tests to fail with status 500, not in production.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { validateXrpcOutput } from '../../src/lexicon/runtime.js';
import {
  xrpcGet,
  xrpcAuthGet,
  xrpcAuthPost,
  getAdminToken,
  createTestUser,
  uniqueHandle,
  isPLCAvailable,
} from './helpers.js';

describe('XRPC output shape smoke tests (issue #65)', () => {
  let adminToken: string;
  let plcAvailable: boolean;
  let communityDid: string | null = null;
  let userToken: string | null = null;
  let userDid: string | null = null;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    plcAvailable = await isPLCAvailable();

    if (!plcAvailable) return;

    const user = await createTestUser(uniqueHandle('smoke'));
    userToken = user.accessJwt;
    userDid = user.did;

    const createRes = await xrpcAuthPost('net.openfederation.community.create', user.accessJwt, {
      handle: uniqueHandle('smoke-comm'),
      didMethod: 'plc',
      displayName: 'Smoke Test Community',
      visibility: 'public',
      joinPolicy: 'open',
    });

    if (createRes.status === 201) {
      communityDid = createRes.body.did;
    }
  });

  // ── Unit: validator rejects Date objects ─────────────────────────────
  // This proves the validator is the correct seam. The integration tests
  // below confirm handlers satisfy it end-to-end.

  it('validateXrpcOutput rejects a Date object in communityItem.createdAt', () => {
    const result = validateXrpcOutput('net.openfederation.community.listAll', {
      communities: [
        {
          did: 'did:plc:example',
          handle: 'test',
          didMethod: 'plc',
          visibility: 'public',
          joinPolicy: 'open',
          memberCount: 0,
          createdAt: new Date() as unknown as string, // Date, not string — pre-19b28f0 shape
          status: 'active',
          isMember: false,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('createdAt must be a string');
  });

  it('validateXrpcOutput accepts an ISO string in communityItem.createdAt', () => {
    const result = validateXrpcOutput('net.openfederation.community.listAll', {
      communities: [
        {
          did: 'did:plc:example',
          handle: 'test',
          didMethod: 'plc',
          visibility: 'public',
          joinPolicy: 'open',
          memberCount: 0,
          createdAt: new Date().toISOString(),
          status: 'active',
          isMember: false,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(result.ok).toBe(true);
  });

  // ── Integration: community.listAll ───────────────────────────────────

  it('community.listAll returns 200 with string createdAt (not Date)', async () => {
    if (!communityDid) return;
    const res = await xrpcGet('net.openfederation.community.listAll');
    // Status 500 here means the output validator rejected a Date object
    expect(res.status).toBe(200);
    expect(res.body.communities.length).toBeGreaterThan(0);
    const item = res.body.communities[0];
    expect(typeof item.createdAt).toBe('string');
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('community.listAll returns structurally valid output shape', async () => {
    const res = await xrpcGet('net.openfederation.community.listAll');
    expect(res.status).toBe(200);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.limit).toBe('number');
    expect(typeof res.body.offset).toBe('number');
    expect(Array.isArray(res.body.communities)).toBe(true);
  });

  // ── Integration: community.listMine ──────────────────────────────────

  it('community.listMine returns 200 with string createdAt (not Date)', async () => {
    if (!communityDid || !userToken) return;
    const res = await xrpcAuthGet('net.openfederation.community.listMine', userToken);
    expect(res.status).toBe(200);
    expect(res.body.communities.length).toBeGreaterThan(0);
    const item = res.body.communities[0];
    expect(typeof item.createdAt).toBe('string');
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ── Integration: community.get ────────────────────────────────────────

  it('community.get returns 200 with string createdAt (not Date)', async () => {
    if (!communityDid) return;
    const res = await xrpcGet('net.openfederation.community.get', { did: communityDid });
    expect(res.status).toBe(200);
    expect(typeof res.body.createdAt).toBe('string');
    expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ── Integration: account.list (admin) ────────────────────────────────
  // account.list passes u.created_at raw; verify the shape validates.

  it('account.list returns 200 with valid output shape', async () => {
    const res = await xrpcAuthGet('net.openfederation.account.list', adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    if (res.body.users.length > 0) {
      expect(typeof res.body.users[0].createdAt).toBe('string');
      expect(res.body.users[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  // ── Integration: server.getSession ───────────────────────────────────

  it('server.getSession returns 200 with valid output shape', async () => {
    if (!userToken) return;
    const res = await xrpcAuthGet('com.atproto.server.getSession', userToken);
    expect(res.status).toBe(200);
    expect(typeof res.body.handle).toBe('string');
    expect(typeof res.body.did).toBe('string');
  });

  // ── Integration: identity.resolveHandle ─────────────────────────────

  it('identity.resolveHandle returns 200 with valid output shape', async () => {
    const res = await xrpcGet('com.atproto.identity.resolveHandle', { handle: 'admin' });
    expect(res.status).toBe(200);
    expect(typeof res.body.did).toBe('string');
    expect(res.body.did).toMatch(/^did:/);
  });

  // ── Integration: community.listMembers ───────────────────────────────

  it('community.listMembers returns 200 with valid output shape', async () => {
    if (!communityDid) return;
    const res = await xrpcGet('net.openfederation.community.listMembers', {
      did: communityDid,
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.members)).toBe(true);
  });

  // ── Integration: server.getPublicConfig ──────────────────────────────

  it('server.getPublicConfig returns 200 with valid output shape', async () => {
    const res = await xrpcGet('net.openfederation.server.getPublicConfig');
    expect(res.status).toBe(200);
    expect(typeof res.body.hostname).toBe('string');
  });
});
