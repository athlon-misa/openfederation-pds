/**
 * Security Regression Tests: Auth Guards
 *
 * Tests for requireAuth, requireRole, and requireApprovedUser guards.
 * Uses mock Express req/res objects — no database or network dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Set required env vars before importing config-dependent modules
process.env.AUTH_JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.KEY_ENCRYPTION_SECRET = 'test-encryption-secret-32-chars!!';

import { requireAuth, requireRole, requireApprovedUser } from '../src/auth/guards.js';
import type { AuthRequest, AuthContext } from '../src/auth/types.js';

/** Create a mock Express Response that captures status and json calls */
function mockResponse() {
  let _status = 200;
  let _json: any = null;
  return {
    status(code: number) {
      _status = code;
      return this;
    },
    json(body: any) {
      _json = body;
      return this;
    },
    get _status() { return _status; },
    get _json() { return _json; },
  } as any;
}

const validAuth: AuthContext = {
  userId: 'user-1',
  handle: 'alice',
  email: 'alice@example.com',
  did: 'did:plc:abc',
  roles: ['user'],
  status: 'approved',
};

describe('requireAuth guard', () => {
  it('returns true when auth is present', () => {
    const req = { auth: validAuth } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireAuth(req, res), true);
  });

  it('returns false and sends 401 when auth is missing', () => {
    const req = { authError: 'missing' } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireAuth(req, res), false);
    assert.equal(res._status, 401);
    assert.equal(res._json.error, 'Unauthorized');
    assert.ok(res._json.message.includes('Missing'));
  });

  it('returns false and sends 401 with "Invalid" message when token is invalid', () => {
    const req = { authError: 'invalid' } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireAuth(req, res), false);
    assert.equal(res._status, 401);
    assert.ok(res._json.message.includes('Invalid'));
  });
});

describe('requireRole guard', () => {
  it('returns true when user has required role', () => {
    const req = { auth: { ...validAuth, roles: ['admin'] } } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireRole(req, res, ['admin']), true);
  });

  it('returns true when user has one of multiple accepted roles', () => {
    const req = { auth: { ...validAuth, roles: ['moderator'] } } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireRole(req, res, ['admin', 'moderator']), true);
  });

  it('returns false and sends 403 when user lacks required role', () => {
    const req = { auth: { ...validAuth, roles: ['user'] } } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireRole(req, res, ['admin']), false);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'Forbidden');
  });

  it('returns false and sends 401 when not authenticated', () => {
    const req = { authError: 'missing' } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireRole(req, res, ['admin']), false);
    assert.equal(res._status, 401);
  });
});

describe('requireApprovedUser guard', () => {
  it('returns true when user status is approved', () => {
    const req = { auth: { ...validAuth, status: 'approved' } } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireApprovedUser(req, res), true);
  });

  it('returns false and sends 403 when user is pending', () => {
    const req = { auth: { ...validAuth, status: 'pending' } } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireApprovedUser(req, res), false);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'AccountNotApproved');
  });

  it('returns false and sends 403 when user is rejected', () => {
    const req = { auth: { ...validAuth, status: 'rejected' } } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireApprovedUser(req, res), false);
    assert.equal(res._status, 403);
  });

  it('returns false and sends 401 when not authenticated', () => {
    const req = { authError: 'missing' } as AuthRequest;
    const res = mockResponse();
    assert.equal(requireApprovedUser(req, res), false);
    assert.equal(res._status, 401);
  });
});
