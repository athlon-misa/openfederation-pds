import { beforeAll, describe, expect, it } from 'vitest';
import { PgAccountStore } from '../../src/oauth/oauth-store.js';
import { query } from '../../src/db/client.js';
import { createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';

describe('OAuth password authentication', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('counts failed password attempts and locks the account', async () => {
    if (!plc) return;
    const handle = uniqueHandle('oauth-lock');
    await createTestUser(handle);
    const store = new PgAccountStore();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(store.authenticateAccount({ username: handle, password: 'wrong-password' } as never))
        .rejects.toThrow('Invalid credentials');
    }

    const result = await query<{ failed_login_attempts: number; locked_until: string | null }>(
      'SELECT failed_login_attempts, locked_until FROM users WHERE handle = $1',
      [handle],
    );
    expect(result.rows[0].failed_login_attempts).toBe(5);
    expect(result.rows[0].locked_until).not.toBeNull();
  });
});
