/**
 * Security Regression Tests: JWT Token Operations
 *
 * Tests for access token signing/verification, algorithm pinning,
 * refresh token generation, and token hashing.
 * Pure unit tests — no database or network dependencies.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

// Set required env vars before importing config-dependent modules
process.env.AUTH_JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.KEY_ENCRYPTION_SECRET = 'test-encryption-secret-32-chars!!';

import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
} from '../src/auth/tokens.js';
import type { AuthContext } from '../src/auth/types.js';

const testContext: AuthContext = {
  userId: 'user-123',
  handle: 'testuser',
  email: 'test@example.com',
  did: 'did:plc:abc123',
  roles: ['user'],
  status: 'approved',
};

describe('Access token signing', () => {
  it('produces a valid JWT string', () => {
    const token = signAccessToken(testContext);
    assert.ok(typeof token === 'string');
    assert.ok(token.split('.').length === 3, 'JWT should have 3 parts');
  });

  it('uses HS256 algorithm', () => {
    const token = signAccessToken(testContext);
    const decoded = jwt.decode(token, { complete: true });
    assert.ok(decoded);
    assert.equal(decoded.header.alg, 'HS256');
  });

  it('includes correct payload fields', () => {
    const token = signAccessToken(testContext);
    const decoded = jwt.decode(token) as any;
    assert.equal(decoded.sub, testContext.userId);
    assert.equal(decoded.handle, testContext.handle);
    assert.equal(decoded.email, testContext.email);
    assert.equal(decoded.did, testContext.did);
    assert.deepEqual(decoded.roles, testContext.roles);
    assert.equal(decoded.status, testContext.status);
  });

  it('sets an expiration time', () => {
    const token = signAccessToken(testContext);
    const decoded = jwt.decode(token) as any;
    assert.ok(decoded.exp, 'Token should have an expiration');
    assert.ok(decoded.exp > Date.now() / 1000, 'Expiration should be in the future');
  });
});

describe('Access token verification', () => {
  it('verifies a valid token and returns AuthContext', () => {
    const token = signAccessToken(testContext);
    const result = verifyAccessToken(token);
    assert.ok(result);
    assert.equal(result.userId, testContext.userId);
    assert.equal(result.handle, testContext.handle);
    assert.equal(result.email, testContext.email);
    assert.equal(result.did, testContext.did);
    assert.deepEqual(result.roles, testContext.roles);
    assert.equal(result.status, testContext.status);
  });

  it('returns null for an expired token', () => {
    const token = jwt.sign(
      { sub: 'user', handle: 'h', email: 'e', did: 'd', roles: ['user'], status: 'approved' },
      process.env.AUTH_JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: '0s' }
    );
    // Wait a tiny bit for expiration
    const result = verifyAccessToken(token);
    assert.equal(result, null);
  });

  it('returns null for a token signed with wrong secret', () => {
    const token = jwt.sign(
      { sub: 'user', handle: 'h', email: 'e', did: 'd', roles: ['user'], status: 'approved' },
      'wrong-secret-that-is-different!!',
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const result = verifyAccessToken(token);
    assert.equal(result, null);
  });

  it('returns null for a malformed token', () => {
    assert.equal(verifyAccessToken('not.a.jwt'), null);
    assert.equal(verifyAccessToken(''), null);
    assert.equal(verifyAccessToken('garbage'), null);
  });

  it('returns null for a token missing required fields', () => {
    const token = jwt.sign(
      { sub: 'user' }, // missing handle, email, did, roles
      process.env.AUTH_JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const result = verifyAccessToken(token);
    assert.equal(result, null);
  });

  it('rejects tokens signed with algorithm "none"', () => {
    // Craft a token with alg: none (algorithm confusion attack)
    const payload = {
      sub: 'admin-user',
      handle: 'admin',
      email: 'admin@evil.com',
      did: 'did:plc:evil',
      roles: ['admin'],
      status: 'approved',
    };
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const noneToken = `${header}.${body}.`;

    const result = verifyAccessToken(noneToken);
    assert.equal(result, null, 'Token with alg:none must be rejected');
  });

  it('rejects tokens signed with HS384 (wrong algorithm)', () => {
    const token = jwt.sign(
      { sub: 'user', handle: 'h', email: 'e', did: 'd', roles: ['user'], status: 'approved' },
      process.env.AUTH_JWT_SECRET!,
      { algorithm: 'HS384', expiresIn: '1h' }
    );
    const result = verifyAccessToken(token);
    assert.equal(result, null, 'Token with wrong algorithm must be rejected');
  });
});

describe('Refresh token generation', () => {
  it('generates a token and hash pair', () => {
    const { token, hash } = generateRefreshToken();
    assert.ok(typeof token === 'string');
    assert.ok(typeof hash === 'string');
    assert.ok(token.length > 0);
    assert.ok(hash.length > 0);
  });

  it('generates unique tokens each time', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateRefreshToken().token));
    assert.equal(tokens.size, 100, 'All refresh tokens should be unique');
  });

  it('hash is deterministic for the same token', () => {
    const { token } = generateRefreshToken();
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    assert.equal(hash1, hash2);
  });

  it('hash differs for different tokens', () => {
    const { token: t1 } = generateRefreshToken();
    const { token: t2 } = generateRefreshToken();
    assert.notEqual(hashToken(t1), hashToken(t2));
  });

  it('token is base64url encoded (no +/= chars)', () => {
    for (let i = 0; i < 20; i++) {
      const { token } = generateRefreshToken();
      assert.ok(!/[+/=]/.test(token), `Token should not contain +, /, or =: ${token}`);
    }
  });
});

describe('Token hashing', () => {
  it('produces a SHA-256 hex string (64 chars)', () => {
    const hash = hashToken('test-token');
    assert.equal(hash.length, 64);
    assert.ok(/^[a-f0-9]{64}$/.test(hash), 'Should be a hex string');
  });

  it('is consistent', () => {
    assert.equal(hashToken('same-input'), hashToken('same-input'));
  });

  it('is different for different inputs', () => {
    assert.notEqual(hashToken('input-a'), hashToken('input-b'));
  });
});
