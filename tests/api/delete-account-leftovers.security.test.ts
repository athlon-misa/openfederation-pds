/**
 * Deleting an account removes what the server held for it: in particular the
 * shares of its rotation key, and the wallet links that would otherwise keep
 * publishing its addresses and keep them "already linked" for everyone else.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { xrpcAuthPost, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle } from './helpers.js';
import { query } from '../../src/db/client.js';

describe('account deletion leftovers', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('removes key shares, wallet links, custody rows and OAuth grants', async () => {
    if (!plc) return;
    const adminToken = await getAdminToken();
    const user = await createTestUser(uniqueHandle('delacct'));
    const wallet = await xrpcAuthPost('net.openfederation.wallet.provision', user.accessJwt, { chain: 'ethereum', label: 'main' });
    expect(wallet.status).toBe(200);
    await query('INSERT INTO oauth_tokens (id, data, current_refresh_token) VALUES ($1, $2, $3)',
      [`tok-${user.did}`, JSON.stringify({ sub: user.did }), `ref-${user.did}`]);

    const count = async (table: string, column: string) =>
      Number((await query<{ c: string }>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = $1`, [user.did])).rows[0].c);
    expect(await count('vault_shares', 'user_did')).toBeGreaterThan(0);
    expect(await count('wallet_links', 'user_did')).toBe(1);

    const res = await xrpcAuthPost('com.atproto.admin.deleteAccount', adminToken, { did: user.did });
    expect(res.status).toBe(200);

    expect(await count('vault_shares', 'user_did')).toBe(0);
    expect(await count('wallet_links', 'user_did')).toBe(0);
    expect(await count('wallet_link_challenges', 'user_did')).toBe(0);
    expect(await count('wallet_custody', 'user_did')).toBe(0);
    expect(await count('user_signing_keys', 'user_did')).toBe(0);
    const grants = await query(`SELECT 1 FROM oauth_tokens WHERE data->>'sub' = $1`, [user.did]);
    expect(grants.rows.length).toBe(0);
  });
});
