/**
 * Security Regression Tests: JWT Token Operations
 *
 * Tests for access token signing/verification, algorithm pinning,
 * refresh token generation, and token hashing.
 * Pure unit tests — no database or network dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';

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

/** Decode a JWT header without verifying (base64url parse) */
function decodeHeader(token: string): Record<string, unknown> {
  const part = token.split('.')[0];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** Decode a JWT payload without verifying (base64url parse) */
function decodePayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** Sign a token with a given secret and options using jose */
async function signWith(
  payload: Record<string, unknown>,
  secret: string,
  opts: { algorithm: string; expiresIn: string }
): Promise<string> {
  const { sub, ...rest } = payload;
  const builder = new SignJWT(rest as Record<string, unknown>)
    .setProtectedHeader({ alg: opts.algorithm })
    .setExpirationTime(opts.expiresIn);
  if (typeof sub === 'string') builder.setSubject(sub);
  return builder.sign(new TextEncoder().encode(secret));
}

describe('Access token signing', () => {
  it('produces a valid JWT string', async () => {
    const token = await signAccessToken(testContext);
    assert.ok(typeof token === 'string');
    assert.ok(token.split('.').length === 3, 'JWT should have 3 parts');
  });

  it('uses HS256 algorithm', async () => {
    const token = await signAccessToken(testContext);
    const header = decodeHeader(token);
    assert.equal(header.alg, 'HS256');
  });

  it('includes correct payload fields', async () => {
    const token = await signAccessToken(testContext);
    const decoded = decodePayload(token);
    assert.equal(decoded.sub, testContext.userId);
    assert.equal(decoded.handle, testContext.handle);
    assert.equal(decoded.email, testContext.email);
    assert.equal(decoded.did, testContext.did);
    assert.deepEqual(decoded.roles, testContext.roles);
    assert.equal(decoded.status, testContext.status);
  });

  it('sets an expiration time', async () => {
    const token = await signAccessToken(testContext);
    const decoded = decodePayload(token);
    assert.ok(decoded.exp, 'Token should have an expiration');
    assert.ok((decoded.exp as number) > Date.now() / 1000, 'Expiration should be in the future');
  });
});

describe('Access token verification', () => {
  it('verifies a valid token and returns AuthContext', async () => {
    const token = await signAccessToken(testContext);
    const result = await verifyAccessToken(token);
    assert.ok(result);
    assert.equal(result.userId, testContext.userId);
    assert.equal(result.handle, testContext.handle);
    assert.equal(result.email, testContext.email);
    assert.equal(result.did, testContext.did);
    assert.deepEqual(result.roles, testContext.roles);
    assert.equal(result.status, testContext.status);
  });

  it('returns null for an expired token', async () => {
    const token = await signWith(
      { sub: 'user', handle: 'h', email: 'e', did: 'd', roles: ['user'], status: 'approved' },
      process.env.AUTH_JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: '0s' }
    );
    const result = await verifyAccessToken(token);
    assert.equal(result, null);
  });

  it('returns null for a token signed with wrong secret', async () => {
    const token = await signWith(
      { sub: 'user', handle: 'h', email: 'e', did: 'd', roles: ['user'], status: 'approved' },
      'wrong-secret-that-is-different!!',
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const result = await verifyAccessToken(token);
    assert.equal(result, null);
  });

  it('returns null for a malformed token', async () => {
    assert.equal(await verifyAccessToken('not.a.jwt'), null);
    assert.equal(await verifyAccessToken(''), null);
    assert.equal(await verifyAccessToken('garbage'), null);
  });

  it('returns null for a token missing required fields', async () => {
    const token = await signWith(
      { sub: 'user' }, // missing handle, email, did, roles
      process.env.AUTH_JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: '1h' }
    );
    const result = await verifyAccessToken(token);
    assert.equal(result, null);
  });

  it('rejects tokens signed with algorithm "none"', async () => {
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

    const result = await verifyAccessToken(noneToken);
    assert.equal(result, null, 'Token with alg:none must be rejected');
  });

  it('rejects tokens signed with HS384 (wrong algorithm)', async () => {
    const token = await signWith(
      { sub: 'user', handle: 'h', email: 'e', did: 'd', roles: ['user'], status: 'approved' },
      process.env.AUTH_JWT_SECRET!,
      { algorithm: 'HS384', expiresIn: '1h' }
    );
    const result = await verifyAccessToken(token);
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
