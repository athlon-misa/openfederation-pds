/**
 * Config-gated oracle endpoint registration (#191).
 *
 * The 4 net.openfederation.oracle.* endpoints must respond with a standard
 * MethodNotImplemented XRPC error — matching the same {error, message} shape
 * used for genuinely unknown methods — when the chain module is not
 * activated (no CHAIN_ADAPTERS, no GOVERNANCE_CHAIN_ENABLED=true). When the
 * module is enabled, behavior must be unchanged from before this gate
 * existed (auth/validation errors still apply — the gate itself just steps
 * out of the way).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setChainModuleEnabledForTests } from '../../src/config.js';
import { xrpcPost, xrpcAuthPost, getAdminToken } from './helpers.js';

const ORACLE_ENDPOINTS = [
  'net.openfederation.oracle.createCredential',
  'net.openfederation.oracle.listCredentials',
  'net.openfederation.oracle.revokeCredential',
  'net.openfederation.oracle.submitProof',
];

describe('Oracle endpoints — module disabled (default test env)', () => {
  it('returns MethodNotImplemented for all 4 oracle endpoints, matching the unknown-method shape', async () => {
    for (const nsid of ORACLE_ENDPOINTS) {
      const res = await xrpcPost(nsid, {});
      expect(res.status, `${nsid} status`).toBe(501);
      expect(res.body.error, `${nsid} error code`).toBe('MethodNotImplemented');
      expect(res.body).toHaveProperty('message');
    }
  });

  it('does not run the handler at all — an authed admin request is still refused', async () => {
    const adminToken = await getAdminToken();
    const res = await xrpcAuthPost('net.openfederation.oracle.createCredential', adminToken, {
      communityDid: 'did:plc:doesnotmatter',
      name: 'should not be created',
    });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('MethodNotImplemented');
  });

  it('matches the same error envelope shape as a genuinely unknown method', async () => {
    const unknown = await xrpcPost('net.openfederation.does.not.exist', {});
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('MethodNotFound');
    expect(Object.keys(unknown.body).sort()).toEqual(['error', 'message']);

    const gated = await xrpcPost('net.openfederation.oracle.submitProof', {});
    expect(Object.keys(gated.body).sort()).toEqual(['error', 'message']);
  });
});

describe('Oracle endpoints — module enabled', () => {
  beforeAll(() => {
    setChainModuleEnabledForTests(true);
  });

  afterAll(() => {
    setChainModuleEnabledForTests(undefined);
  });

  it('submitProof passes the gate and reaches normal validation (400, not 501)', async () => {
    const res = await xrpcPost('net.openfederation.oracle.submitProof', {
      chainId: 'eip155:1',
      transactionHash: '0xabc123',
    });
    // No X-Oracle-Key -> AuthRequired from the handler, proving the gate
    // stepped aside rather than short-circuiting.
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AuthRequired');
  });

  it('createCredential passes the gate and reaches the admin-auth guard', async () => {
    const res = await xrpcPost('net.openfederation.oracle.createCredential', {
      communityDid: 'did:plc:doesnotmatter',
      name: 'gate-check',
    });
    expect(res.status).not.toBe(501);
  });

  it('listCredentials and revokeCredential pass the gate', async () => {
    const listRes = await xrpcPost('net.openfederation.oracle.listCredentials', {});
    expect(listRes.status).not.toBe(501);

    const revokeRes = await xrpcPost('net.openfederation.oracle.revokeCredential', {
      credentialId: 'does-not-exist',
    });
    expect(revokeRes.status).not.toBe(501);
  });
});
