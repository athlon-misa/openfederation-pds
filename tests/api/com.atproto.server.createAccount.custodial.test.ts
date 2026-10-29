/**
 * A user account moving here (#266): the old PDS vouches for it with
 * service auth, the account opens deactivated with a password here, and
 * this PDS makes a rotation key for it, split 2-of-3.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { xrpcPost, xrpcAuthGet, xrpcAuthPost, getAdminToken, isPLCAvailable } from './helpers.js';
import { config } from '../../src/config.js';
import { query } from '../../src/db/client.js';
import { userElsewhere, serviceAuthFor, createAccount, newHandle } from './migration-helpers.js';

const PASSWORD = 'MovingHouse-2026!';
const original = { ...config.migration };

async function body(u: { did: string }, extra: Record<string, unknown> = {}) {
  return { did: u.did, handle: newHandle(), email: `${u.did.slice(-8)}@moved.example`, password: PASSWORD, ...extra };
}

describe('com.atproto.server.createAccount (user account, service auth)', () => {
  let plc = false;
  beforeAll(async () => { plc = await isPLCAvailable(); });
  afterEach(() => { Object.assign(config.migration, original); });

  it('opens a deactivated account with a password and a custodial rotation key', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    config.migration.accounts = 'open';
    const u = await userElsewhere();
    const b = await body(u);
    const res = await createAccount(b, await serviceAuthFor(u));
    expect(res.status).toBe(200);
    expect(res.body.did).toBe(u.did);
    expect(res.body.rotationDeviceShare).toMatch(/^8/); // a Shamir share (index 1 of 3)

    const row = (await query<{ status: string; migrating_in: boolean; auth_type: string; rotation_did_key: string }>(
      'SELECT status, migrating_in, auth_type, rotation_did_key FROM users WHERE did = $1', [u.did])).rows[0];
    expect(row).toMatchObject({ status: 'deactivated', migrating_in: true, auth_type: 'local' });
    expect(row.rotation_did_key).toMatch(/^did:key:zQ3s/);
    const shares = (await query<{ share_index: number }>('SELECT share_index FROM vault_shares WHERE user_did = $1 ORDER BY 1', [u.did])).rows;
    expect(shares.map((s) => s.share_index)).toEqual([2, 3]);

    const creds = await xrpcAuthGet('com.atproto.identity.getRecommendedDidCredentials', res.body.accessJwt);
    expect(creds.body.rotationKeys).toEqual([row.rotation_did_key]);
    expect(creds.body.verificationMethods.atproto).toMatch(/^did:key:/);

    // The password works here already, for the limited session.
    const login = await xrpcPost('com.atproto.server.createSession', { identifier: b.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ did: u.did, active: false, status: 'deactivated' });
    expect((await xrpcAuthGet('com.atproto.server.checkAccountStatus', login.body.accessJwt)).body.activated).toBe(false);
  });

  it('refuses a token minted for another DID, a weak password, and the closed gate', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    config.migration.accounts = 'open';
    const u = await userElsewhere();
    const other = await userElsewhere();
    const wrongDid = await createAccount(await body(u), await serviceAuthFor(other));
    expect(wrongDid.status).toBe(401);
    expect(wrongDid.body.error).toBe('InvalidToken');

    const weak = await createAccount(await body(u, { password: 'short' }), await serviceAuthFor(u));
    expect(weak.status).toBe(400);
    expect(weak.body.error).toBe('InvalidPassword');

    config.migration.accounts = 'closed';
    const closed = await createAccount(await body(u), await serviceAuthFor(u));
    expect(closed.status).toBe(403);
    expect(closed.body.error).toBe('MigrationNotAllowed');
    expect((await query('SELECT 1 FROM users WHERE did = $1', [u.did])).rows).toHaveLength(0);
  });

  it('invite mode: needs a valid invite code, claimed once', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    config.migration.accounts = 'invite';
    const u = await userElsewhere();
    const none = await createAccount(await body(u), await serviceAuthFor(u));
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('InvalidInviteCode');
    const bad = await createAccount(await body(u, { inviteCode: 'NOPE-NOPE' }), await serviceAuthFor(u));
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe('InviteInvalid');

    const admin = await getAdminToken();
    const invite = await xrpcAuthPost('net.openfederation.invite.create', admin, {});
    expect(invite.status).toBe(201);
    const ok = await createAccount(await body(u, { inviteCode: invite.body.code }), await serviceAuthFor(u));
    expect(ok.status).toBe(200);
    const again = await userElsewhere();
    const used = await createAccount(await body(again, { inviteCode: invite.body.code }), await serviceAuthFor(again));
    expect(used.status).toBe(403);
    expect(used.body.error).toBe('InviteUsed');
  });

  it('a user DID without service auth is told how to move', async (ctx) => {
    if (!plc) ctx.skip('PLC directory not available');
    config.migration.accounts = 'open';
    const u = await userElsewhere();
    const res = await createAccount(await body(u));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IncompatibleDidDoc');
  });
});
