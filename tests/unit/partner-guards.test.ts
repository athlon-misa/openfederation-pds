import { describe, it, expect } from 'vitest';
// Oracle guard coverage lives in tests/unit/oracle-auth-module.test.ts — the
// X-Oracle-Key guard is chain-module surface and no longer part of core guards.
import { requirePartnerAuth } from '../../src/auth/guards.js';
import type { Response } from 'express';

function mockRes(): Response & { statusCode: number; body: unknown } {
  const r = { statusCode: 200, body: null as unknown } as any;
  r.status = (code: number) => { r.statusCode = code; return r; };
  r.json = (data: unknown) => { r.body = data; return r; };
  return r;
}

describe('requirePartnerAuth', () => {
  it('returns false and sends 401 when partnerAuth is absent', () => {
    const req = {} as any;
    const res = mockRes();
    expect(requirePartnerAuth(req, res, 'register')).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('returns false and sends 403 when partner lacks the required permission', () => {
    const req = { partnerAuth: { permissions: ['list'] } } as any;
    const res = mockRes();
    expect(requirePartnerAuth(req, res, 'register')).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('returns true when partnerAuth has the required permission', () => {
    const req = { partnerAuth: { permissions: ['register', 'list'] } } as any;
    const res = mockRes();
    expect(requirePartnerAuth(req, res, 'register')).toBe(true);
    expect(res.statusCode).toBe(200);
  });
});
