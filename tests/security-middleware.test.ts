/**
 * Security Regression Tests: Auth Middleware
 *
 * Tests for Bearer token extraction and auth context population.
 * Uses mock Express req/res/next — no database or network dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Set required env vars before importing config-dependent modules
process.env.AUTH_JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.KEY_ENCRYPTION_SECRET = 'test-encryption-secret-32-chars!!';

import { authMiddleware } from '../src/auth/middleware.js';
import { signAccessToken } from '../src/auth/tokens.js';
import type { AuthRequest, AuthContext } from '../src/auth/types.js';

const testContext: AuthContext = {
  userId: 'user-123',
  handle: 'testuser',
  email: 'test@example.com',
  did: 'did:plc:abc123',
  roles: ['user'],
  status: 'approved',
};

function mockReq(headers: Record<string, string> = {}): AuthRequest {
  return { headers } as AuthRequest;
}

function mockRes(): any {
  return {};
}

describe('authMiddleware', () => {
  it('populates req.auth for a valid Bearer token', async () => {
    const token = await signAccessToken(testContext);
    const req = mockReq({ authorization: `Bearer ${token}` });
    let called = false;

    await authMiddleware(req, mockRes(), () => { called = true; });

    assert.ok(called, 'next() should be called');
    assert.ok(req.auth, 'req.auth should be set');
    assert.equal(req.auth!.userId, testContext.userId);
    assert.equal(req.auth!.handle, testContext.handle);
    assert.equal(req.auth!.did, testContext.did);
    assert.equal(req.authError, undefined);
  });

  it('sets authError to "missing" when no Authorization header', async () => {
    const req = mockReq();
    let called = false;

    await authMiddleware(req, mockRes(), () => { called = true; });

    assert.ok(called, 'next() should be called');
    assert.equal(req.auth, undefined);
    assert.equal(req.authError, 'missing');
  });

  it('sets authError to "invalid" when Authorization is not Bearer scheme', async () => {
    const req = mockReq({ authorization: 'Basic dXNlcjpwYXNz' });
    let called = false;

    await authMiddleware(req, mockRes(), () => { called = true; });

    assert.ok(called, 'next() should be called');
    assert.equal(req.auth, undefined);
    assert.equal(req.authError, 'invalid');
  });

  it('sets authError to "missing" when Bearer token is empty', async () => {
    const req = mockReq({ authorization: 'Bearer ' });
    let called = false;

    await authMiddleware(req, mockRes(), () => { called = true; });

    assert.ok(called, 'next() should be called');
    assert.equal(req.auth, undefined);
    assert.equal(req.authError, 'missing');
  });

  it('sets authError to "invalid" for a malformed token', async () => {
    const req = mockReq({ authorization: 'Bearer not-a-valid-jwt' });
    let called = false;

    await authMiddleware(req, mockRes(), () => { called = true; });

    assert.ok(called, 'next() should be called');
    assert.equal(req.auth, undefined);
    assert.equal(req.authError, 'invalid');
  });

  it('always calls next() regardless of auth outcome', async () => {
    const validToken = await signAccessToken(testContext);
    const cases = [
      mockReq(),                                         // no header
      mockReq({ authorization: 'Basic abc' }),           // wrong scheme
      mockReq({ authorization: 'Bearer garbage' }),      // bad token
      mockReq({ authorization: `Bearer ${validToken}` }), // valid
    ];

    for (const req of cases) {
      let called = false;
      await authMiddleware(req, mockRes(), () => { called = true; });
      assert.ok(called, 'next() must always be called');
    }
  });
});
