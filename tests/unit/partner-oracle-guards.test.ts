import { describe, it, expect } from 'vitest';
import { requirePartnerAuth, requireOracleAuth } from '../../src/auth/guards.js';
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

describe('requireOracleAuth', () => {
  it('returns false and sends 401 when oracleAuth is absent', () => {
    const req = {} as any;
    const res = mockRes();
    expect(requireOracleAuth(req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('returns true when oracleAuth is set', () => {
    const req = { oracleAuth: { credentialId: 'cred-1', communityDid: 'did:plc:foo', name: 'Oracle' } } as any;
    const res = mockRes();
    expect(requireOracleAuth(req, res)).toBe(true);
    expect(res.statusCode).toBe(200);
  });
});
