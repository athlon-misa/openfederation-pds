/**
 * The lockout has to hold against guesses sent at the same moment, and on
 * every endpoint that checks a password, not only on login.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcPost, xrpcAuthPost, createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

describe('login lockout', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('a burst of parallel wrong passwords gets no more guesses than a slow one would', async () => {
    if (!plc) return;
    const handle = uniqueHandle('lockrace');
    await createTestUser(handle);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      xrpcPost('com.atproto.server.createSession', { identifier: handle, password: `WrongGuess${i}!` })));
    const checked = results.filter(r => r.status === 401).length;
    const locked = results.filter(r => r.status === 429).length;
    expect(checked).toBeLessThanOrEqual(5);
    expect(checked + locked).toBe(30);
  });

  it('a correct password still works after a few failures, and clears the count', async () => {
    if (!plc) return;
    const handle = uniqueHandle('lockrace');
    const user = await createTestUser(handle);
    for (let i = 0; i < 3; i++) {
      await xrpcPost('com.atproto.server.createSession', { identifier: handle, password: 'Nope12345!' });
    }
    const ok = await xrpcPost('com.atproto.server.createSession', { identifier: handle, password: 'TestPassword123!' });
    expect(ok.status).toBe(200);
    const row = await query<{ failed_login_attempts: number }>('SELECT failed_login_attempts FROM users WHERE did = $1', [user.did]);
    expect(row.rows[0].failed_login_attempts).toBe(0);
  });

  it('guessing the current password through changePassword counts toward the lockout', async () => {
    if (!plc) return;
    const handle = uniqueHandle('lockrace');
    const user = await createTestUser(handle);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await xrpcAuthPost('net.openfederation.account.changePassword', user.accessJwt, {
        currentPassword: `WrongGuess${i}!`, newPassword: 'BrandNewPassword789!',
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every(s => s === 400)).toBe(true);
    expect(statuses.slice(5).every(s => s === 429)).toBe(true);
  });
});
