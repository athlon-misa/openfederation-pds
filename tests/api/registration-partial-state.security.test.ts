/**
 * Registration either produces a whole account or nothing: no identity is
 * registered for a request that was always going to be refused, and no account
 * is left behind whose keys were never stored.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { xrpcPost, xrpcAuthPost, getAdminToken, isPLCAvailable, uniqueHandle, createTestUser } from './helpers.js';
import { query } from '../../src/db/client.js';
import * as userIdentity from '../../src/identity/user-identity.js';

const shareRows = async () => Number((await query<{ c: string }>('SELECT COUNT(*) AS c FROM vault_shares')).rows[0].c);

describe('registration partial state', () => {
  let plc: boolean;
  let adminToken: string;
  beforeAll(async () => { plc = await isPLCAvailable(); adminToken = await getAdminToken(); });
  afterEach(() => vi.restoreAllMocks());

  const invite = async () =>
    (await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 })).body.code as string;

  it('creates no identity for a registration with an invalid invite code', async () => {
    if (!plc) return;
    const before = await shareRows();
    const handle = uniqueHandle('partial');
    const res = await xrpcPost('net.openfederation.account.register', {
      handle, email: `${handle}@test.local`, password: 'TestPassword123!', inviteCode: 'not-a-real-code',
    });
    expect(res.status).toBe(403);
    expect(await shareRows()).toBe(before);
  });

  it('creates no identity for a registration whose handle is taken', async () => {
    if (!plc) return;
    const taken = uniqueHandle('partial');
    await createTestUser(taken);
    const before = await shareRows();
    const res = await xrpcPost('net.openfederation.account.register', {
      handle: taken, email: `${uniqueHandle('other')}@test.local`, password: 'TestPassword123!', inviteCode: await invite(),
    });
    expect(res.status).toBe(409);
    expect(await shareRows()).toBe(before);
  });

  it('does not leave an account behind when its signing key could not be stored', async () => {
    if (!plc) return;
    vi.spyOn(userIdentity, 'storeUserSigningKey').mockRejectedValue(new Error('encryption unavailable'));
    const handle = uniqueHandle('partial');
    const res = await xrpcPost('net.openfederation.account.register', {
      handle, email: `${handle}@test.local`, password: 'TestPassword123!', inviteCode: await invite(),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const user = await query('SELECT 1 FROM users WHERE handle = $1', [handle]);
    expect(user.rows.length).toBe(0);
  });

  it('a normal registration still works and has its keys', async () => {
    if (!plc) return;
    const handle = uniqueHandle('partial');
    const res = await xrpcPost('net.openfederation.account.register', {
      handle, email: `${handle}@test.local`, password: 'TestPassword123!', inviteCode: await invite(),
    });
    expect(res.status).toBe(201);
    const key = await query('SELECT 1 FROM user_signing_keys WHERE user_did = $1', [res.body.did]);
    expect(key.rows.length).toBe(1);
    const shares = await query('SELECT 1 FROM vault_shares WHERE user_did = $1', [res.body.did]);
    expect(shares.rows.length).toBe(2);
    const repo = await query('SELECT 1 FROM repo_roots WHERE did = $1', [res.body.did]);
    expect(repo.rows.length).toBe(1);
  });
});
