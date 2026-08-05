import { describe, it, expect } from 'vitest';
import { xrpcAuthGet, xrpcAuthPost, xrpcPost, getAdminHandle, getAdminPassword } from './helpers.js';
import { query } from '../../src/db/client.js';

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

  it('rejects an access token after its user token version is incremented', async () => {
    const login = await xrpcPost('com.atproto.server.createSession', {
      identifier: handle,
      password,
    });
    expect(login.status).toBe(200);

    await query('UPDATE users SET token_version = token_version + 1 WHERE handle = $1', [handle]);

    const stale = await xrpcAuthGet('com.atproto.server.getSession', login.body.accessJwt);
    expect(stale.status).toBe(401);

    const freshLogin = await xrpcPost('com.atproto.server.createSession', {
      identifier: handle,
      password,
    });
    expect(freshLogin.status).toBe(200);
    const fresh = await xrpcAuthGet('com.atproto.server.getSession', freshLogin.body.accessJwt);
    expect(fresh.status).toBe(200);
  });

  it('allows exactly one concurrent refresh-token rotation', async () => {
    const login = await xrpcPost('com.atproto.server.createSession', {
      identifier: handle,
      password,
    });
    expect(login.status).toBe(200);

    await query(`
      CREATE OR REPLACE FUNCTION test_refresh_rotation_pause()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.25); RETURN NEW; END; $$;
    `);
    await query(`
      CREATE TRIGGER test_refresh_rotation_pause
      BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION test_refresh_rotation_pause();
    `);
    try {
      const results = await Promise.all([
        xrpcPost('com.atproto.server.refreshSession', { refreshJwt: login.body.refreshJwt }),
        xrpcPost('com.atproto.server.refreshSession', { refreshJwt: login.body.refreshJwt }),
      ]);
      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      expect(results.filter((result) => result.status === 401)).toHaveLength(1);
    } finally {
      await query('DROP TRIGGER IF EXISTS test_refresh_rotation_pause ON sessions');
      await query('DROP FUNCTION IF EXISTS test_refresh_rotation_pause()');
    }
  });

  it('revokes a refresh token when its session is deleted', async () => {
    const login = await xrpcPost('com.atproto.server.createSession', {
      identifier: handle,
      password,
    });
    expect(login.status).toBe(200);

    const refreshJwt = login.body.refreshJwt;
    const logout = await xrpcAuthPost('com.atproto.server.deleteSession', login.body.accessJwt, { refreshJwt });
    expect(logout.status).toBe(200);

    const replay = await xrpcPost('com.atproto.server.refreshSession', { refreshJwt });
    expect(replay.status).toBe(401);
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

  it('counts concurrent failed passwords without lost updates', async () => {
    await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE handle = $1', [handle]);
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => xrpcPost('com.atproto.server.createSession', {
          identifier: handle,
          password: 'WrongPassword999!',
        })),
      );
      expect(results.every((result) => result.status === 401)).toBe(true);
      const user = await query<{ failed_login_attempts: number; locked_until: string | null }>(
        'SELECT failed_login_attempts, locked_until FROM users WHERE handle = $1',
        [handle],
      );
      expect(user.rows[0].failed_login_attempts).toBe(5);
      expect(user.rows[0].locked_until).not.toBeNull();
    } finally {
      await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE handle = $1', [handle]);
    }
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
