import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcPost, xrpcAuthPost, getAdminToken } from './helpers.js';

describe('net.openfederation.invite.create', () => {
  // Uses the bootstrap admin — no PLC directory required.
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getAdminToken();
  });

  // === HAPPY PATH ===

  it('should create invite with default maxUses', async () => {
    const res = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {});
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('code');
    expect(res.body.maxUses).toBe(1);
    expect(typeof res.body.code).toBe('string');
    expect(res.body.code.length).toBeGreaterThan(0);
  });

  it('should create invite with custom maxUses', async () => {
    const res = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {
      maxUses: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body.maxUses).toBe(5);
  });

  it('should create invite with expiresAt', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const res = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {
      maxUses: 1,
      expiresAt: future,
    });
    expect(res.status).toBe(201);
    expect(res.body.expiresAt).toBeTruthy();
  });

  // === AUTH TESTS ===

  it('should reject without auth token', async () => {
    const res = await xrpcPost('net.openfederation.invite.create', { maxUses: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('should reject invalid auth token', async () => {
    const res = await xrpcAuthPost('net.openfederation.invite.create', 'invalid-token', {
      maxUses: 1,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  // === VALIDATION ===

  it('should reject maxUses of 0', async () => {
    const res = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {
      maxUses: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('should reject negative maxUses', async () => {
    const res = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {
      maxUses: -1,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('should reject non-integer maxUses', async () => {
    const res = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {
      maxUses: 1.5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('should reject invalid expiresAt date', async () => {
    const res = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {
      maxUses: 1,
      expiresAt: 'not-a-date',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  // === RESPONSE SHAPE ===

  it('should return unique codes per invocation', async () => {
    const res1 = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {});
    const res2 = await xrpcAuthPost('net.openfederation.invite.create', adminToken, {});
    expect(res1.body.code).not.toBe(res2.body.code);
  });
});
