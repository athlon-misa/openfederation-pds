import request from 'supertest';
import { app } from '../../src/server/index.js';

export const api = request(app);

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
const ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'AdminPass1234';

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
  try {
    const url = process.env.PLC_DIRECTORY_URL || 'http://localhost:2582';
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
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
  if (registerRes.body.userId) {
    await xrpcAuthPost('net.openfederation.account.approve', adminToken, {
      userId: registerRes.body.userId,
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
  return `${prefix}-${Date.now()}-${counter}`;
}
