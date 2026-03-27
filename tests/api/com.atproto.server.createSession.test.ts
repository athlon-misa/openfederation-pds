import { describe, it, expect } from 'vitest';
import { xrpcPost, getAdminHandle, getAdminPassword } from './helpers.js';

describe('com.atproto.server.createSession', () => {
  // Uses the bootstrap admin account — no PLC directory required.
  const handle = getAdminHandle();
  const password = getAdminPassword();

  // === HAPPY PATH ===

  it('should login with valid handle and password', async () => {
    const res = await xrpcPost('com.atproto.server.createSession', {
      identifier: handle,
      password,
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('did');
    expect(res.body).toHaveProperty('handle', handle);
    expect(res.body).toHaveProperty('accessJwt');
    expect(res.body).toHaveProperty('refreshJwt');
    expect(res.body.active).toBe(true);
  });

  it('should return JWT-formatted access token', async () => {
    const res = await xrpcPost('com.atproto.server.createSession', {
      identifier: handle,
      password,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessJwt).toBe('string');
    expect(res.body.accessJwt.split('.')).toHaveLength(3); // JWT has 3 parts
  });

  // === VALIDATION ===

  it('should reject missing identifier', async () => {
    const res = await xrpcPost('com.atproto.server.createSession', {
      password: 'SomePassword123!',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('should reject missing password', async () => {
    const res = await xrpcPost('com.atproto.server.createSession', {
      identifier: handle,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  it('should reject empty body', async () => {
    const res = await xrpcPost('com.atproto.server.createSession', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });

  // === AUTH FAILURES ===

  it('should reject wrong password', async () => {
    const res = await xrpcPost('com.atproto.server.createSession', {
      identifier: handle,
      password: 'WrongPassword999!',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('should reject non-existent user', async () => {
    const res = await xrpcPost('com.atproto.server.createSession', {
      identifier: 'definitely-not-a-real-user',
      password: 'SomePassword123!',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  // === RESPONSE SHAPE ===

  it('should include email in response', async () => {
    const res = await xrpcPost('com.atproto.server.createSession', {
      identifier: handle,
      password,
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('email');
    expect(typeof res.body.email).toBe('string');
  });
});
