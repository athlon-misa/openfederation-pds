/**
 * Refresh-token rotation: replaying any token the session has already rotated
 * away revokes every session, however many rotations ago it was. Two requests
 * racing with the same current token (two browser tabs) are not a replay.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { xrpcPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { config } from '../../src/config.js';

const refresh = (refreshJwt: string) => xrpcPost('com.atproto.server.refreshSession', { refreshJwt });

describe('refresh token reuse detection', () => {
  let plc: boolean;
  const originalGrace = config.auth.refreshReuseGraceMs;
  beforeAll(async () => { plc = await isPLCAvailable(); });
  afterEach(() => { config.auth.refreshReuseGraceMs = originalGrace; });

  it('revokes every session when a token from two rotations ago is replayed', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('reuse'));
    const t0 = user.refreshJwt;
    const r1 = await refresh(t0);
    expect(r1.status).toBe(200);
    const r2 = await refresh(r1.body.refreshJwt);
    expect(r2.status).toBe(200);

    const replay = await refresh(t0);
    expect(replay.status).toBe(401);

    // The thief's (or the victim's) current token is dead too.
    const after = await refresh(r2.body.refreshJwt);
    expect(after.status).toBe(401);
  });

  it('revokes every session when the previous token is replayed after the grace window', async () => {
    if (!plc) return;
    config.auth.refreshReuseGraceMs = 0;
    const user = await createTestUser(uniqueHandle('reuse'));
    const r1 = await refresh(user.refreshJwt);
    expect(r1.status).toBe(200);

    const replay = await refresh(user.refreshJwt);
    expect(replay.status).toBe(401);
    const after = await refresh(r1.body.refreshJwt);
    expect(after.status).toBe(401);
  });

  it('lets two requests racing with the same current token both continue', async () => {
    if (!plc) return;
    config.auth.refreshReuseGraceMs = 10_000;
    const user = await createTestUser(uniqueHandle('reuse'));
    const [a, b] = await Promise.all([refresh(user.refreshJwt), refresh(user.refreshJwt)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.refreshJwt).not.toBe(b.body.refreshJwt);

    // Neither tab was logged out: both successors still work.
    expect((await refresh(a.body.refreshJwt)).status).toBe(200);
    expect((await refresh(b.body.refreshJwt)).status).toBe(200);
  });
});
