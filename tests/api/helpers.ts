import request from 'supertest';
import { app } from '../../src/server/index.js';

/**
 * One server for the whole file, not one per request (#222).
 *
 * `request(app)` makes supertest call `app.listen(0)` for **every request**,
 * so a full suite churns through thousands of OS-assigned ephemeral ports
 * (49152–65535 on macOS). That range is shared with every other local daemon,
 * and the tests were intermittently talking to one of them: a captured failure
 * shows a request answered by `server: CCLibrary/4.18.2` — Adobe Creative
 * Cloud — with `405 MethodNotAllowed`, and others arriving as `ECONNRESET`
 * from ports with nothing listening.
 *
 * That is why the failure moved: it belonged to whichever request happened to
 * draw a contended port, not to any test. Handing supertest a server that is
 * already listening makes it reuse that one address for every request, so the
 * churn — and the collision window — stops existing.
 *
 * `unref()` so a live listener never keeps the vitest worker alive.
 */
const server = app.listen(0);
server.unref();

export const api = request(server);

// ── Unauthenticated XRPC helpers ─────────────────────────────────

/** POST to an XRPC endpoint without authentication */
export function xrpcPost(nsid: string, body?: any) {
  return api.post(`/xrpc/${nsid}`).send(body || {});
}

/** GET from an XRPC endpoint without authentication */
export function xrpcGet(nsid: string, params?: Record<string, string>) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return api.get(`/xrpc/${nsid}${qs}`);
}

// ── Authenticated XRPC helpers ───────────────────────────────────

/** POST to an XRPC endpoint with Bearer token */
export function xrpcAuthPost(nsid: string, token: string, body?: any) {
  return api
    .post(`/xrpc/${nsid}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body || {});
}

/**
 * POST with a Bearer token and an explicit browser `Origin`.
 *
 * Custodial wallet consent and signing bind the consent to the origin the
 * request came from (issue #101), so those endpoints need a real Origin the
 * way a browser would send one. Supertest sends none by default.
 */
export function xrpcAuthPostFromOrigin(nsid: string, token: string, origin: string, body?: any) {
  return api
    .post(`/xrpc/${nsid}`)
    .set('Authorization', `Bearer ${token}`)
    .set('Origin', origin)
    .send(body || {});
}

/** GET from an XRPC endpoint with Bearer token */
export function xrpcAuthGet(nsid: string, token: string, params?: Record<string, string>) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return api
    .get(`/xrpc/${nsid}${qs}`)
    .set('Authorization', `Bearer ${token}`);
}

// ── Auth setup helpers ───────────────────────────────────────────

/** Admin credentials from .env (bootstrap admin, always exists in DB) */
const ADMIN_HANDLE = process.env.BOOTSTRAP_ADMIN_HANDLE || 'admin';
const ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Bootstrap-Test-Password-47!';

/**
 * Login as the bootstrap admin.
 * The bootstrap admin is created on first server start via ensureBootstrapAdmin().
 * Does NOT require PLC directory.
 */
export async function getAdminToken(): Promise<string> {
  const res = await xrpcPost('com.atproto.server.createSession', {
    identifier: ADMIN_HANDLE,
    password: ADMIN_PASSWORD,
  });
  if (res.status !== 200) {
    throw new Error(`Failed to get admin token: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessJwt;
}

/** Get admin handle for use in tests */
export function getAdminHandle(): string {
  return ADMIN_HANDLE;
}

/** Get admin password for use in tests */
export function getAdminPassword(): string {
  return ADMIN_PASSWORD;
}

/**
 * Check if the PLC directory is reachable.
 * Tests that require user registration (which creates did:plc) should
 * skip if PLC is down.
 */
export async function isPLCAvailable(): Promise<boolean> {
  const url = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
  // @did-plc/server exposes its readiness endpoint as /_health. Keep the
  // legacy /health fallback for compatible PLC directory implementations.
  for (const path of ['/_health', '/health']) {
    try {
      const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // Try the compatibility endpoint before reporting the directory unavailable.
    }
  }

  if (process.env.CI) {
    throw new Error('PLC directory is unavailable in CI');
  }

  return false;
}

/**
 * Create a test user via the invite + register + approve flow.
 * REQUIRES PLC directory to be running (registration creates did:plc).
 * Returns session tokens and user info.
 */
export async function createTestUser(
  handle: string,
  opts: { role?: string } = {}
): Promise<{ accessJwt: string; refreshJwt: string; did: string; handle: string }> {
  const adminToken = await getAdminToken();

  // 1. Create invite code
  const inviteRes = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {
    maxUses: 1,
  });
  if (inviteRes.status !== 201) {
    throw new Error(`Failed to create invite: ${inviteRes.status} ${JSON.stringify(inviteRes.body)}`);
  }
  const inviteCode = inviteRes.body.code;

  // 2. Register account (requires PLC directory)
  const registerRes = await xrpcPost('net.openfederation.account.register', {
    handle,
    email: `${handle}@test.local`,
    password: 'TestPassword123!',
    inviteCode,
  });
  if (registerRes.status !== 201 && registerRes.status !== 200) {
    throw new Error(`Failed to register: ${registerRes.status} ${JSON.stringify(registerRes.body)}`);
  }

  // 3. Approve account
  const registeredUserId = registerRes.body.userId || registerRes.body.id;
  if (registeredUserId) {
    await xrpcAuthPost('net.openfederation.account.approve', adminToken, {
      userId: registeredUserId,
    });
  }

  // 4. Login to get tokens
  const loginRes = await xrpcPost('com.atproto.server.createSession', {
    identifier: handle,
    password: 'TestPassword123!',
  });
  if (loginRes.status !== 200) {
    throw new Error(`Failed to login as ${handle}: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }

  // 5. Assign additional role if requested
  if (opts.role && opts.role !== 'user') {
    await xrpcAuthPost('net.openfederation.account.updateRoles', adminToken, {
      did: loginRes.body.did,
      addRoles: [opts.role],
    });
  }

  return {
    accessJwt: loginRes.body.accessJwt,
    refreshJwt: loginRes.body.refreshJwt,
    did: loginRes.body.did,
    handle: loginRes.body.handle,
  };
}

/** Generate a unique handle for tests to avoid collisions */
let counter = 0;
export function uniqueHandle(prefix = 'test'): string {
  counter++;
  const suffix = `-${Date.now()}-${counter}`;
  return `${prefix.slice(0, 30 - suffix.length)}${suffix}`;
}
