import { beforeAll, describe, expect, it } from 'vitest';
import { PgAccountStore } from '../../src/oauth/oauth-store.js';
import { query } from '../../src/db/client.js';
import { isPLCAvailable, uniqueHandle } from './helpers.js';

describe('OAuth invite consumption', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('allows only one account to consume a single-use invite concurrently', async () => {
    if (!plc) return;
    const inviteCode = `oauth-race-${Date.now()}`;
    await query('INSERT INTO invites (code, max_uses, uses_count) VALUES ($1, 1, 0)', [inviteCode]);
    const store = new PgAccountStore();
    const create = (suffix: string) => store.createAccount({
      handle: uniqueHandle(`oauth-${suffix}`),
      email: `oauth-${suffix}-${Date.now()}@test.local`,
      password: 'TestPassword123!',
      inviteCode,
    } as never);

    const results = await Promise.allSettled([create('one'), create('two')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
