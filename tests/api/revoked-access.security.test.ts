/**
 * When an account is suspended, or its owner resets credentials or revokes
 * everything, every way in has to close: local sessions, OAuth grants, and
 * service-auth tokens minted for this PDS itself.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';
import {
  xrpcAuthPost, xrpcAuthGet, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { signServiceAuthJwt } from '../../src/auth/service-auth.js';
import { invalidateAuthContext } from '../../src/auth/auth-context-cache.js';

async function fakeOAuthGrant(did: string): Promise<string> {
  const id = `tok-${randomBytes(8).toString('hex')}`;
  await query('INSERT INTO oauth_tokens (id, data, current_refresh_token) VALUES ($1, $2, $3)',
    [id, JSON.stringify({ sub: did, clientId: 'https://attacker.example/client.json' }), `ref-${id}`]);
  return id;
}
const grantExists = async (id: string) =>
  (await query('SELECT 1 FROM oauth_tokens WHERE id = $1', [id])).rows.length > 0;

describe('revoked access', () => {
  let plc: boolean;
  beforeAll(async () => { plc = await isPLCAvailable(); });

  it('a suspended account is refused even with a credential that is still valid', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('revoked'));
    // A service-auth token signed with the account's own key stands in for any
    // credential a suspension does not invalidate by itself (an OAuth grant is
    // the other): it is verified against the DID, not against a session.
    const token = () => getKeypairForDid(user.did).then((keypair) => signServiceAuthJwt({
      keypair, iss: user.did, aud: config.pds.serviceDid,
      exp: Math.floor(Date.now() / 1000) + 60, lxm: 'net.openfederation.community.listMine',
    }));
    await query(`UPDATE users SET status = 'suspended' WHERE did = $1`, [user.did]);
    invalidateAuthContext(user.did);
    const res = await xrpcAuthGet('net.openfederation.community.listMine', await token());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AccountSuspended');

    await query(`UPDATE users SET status = 'takendown' WHERE did = $1`, [user.did]);
    invalidateAuthContext(user.did);
    const gone = await xrpcAuthGet('net.openfederation.community.listMine', await token());
    expect(gone.status).toBe(410);
  });

  it('revoking all sessions also ends OAuth grants', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('revoked'));
    const grant = await fakeOAuthGrant(user.did);
    const res = await xrpcAuthPost('net.openfederation.account.revokeSession', user.accessJwt, { revokeAll: true });
    expect(res.status).toBe(200);
    expect(await grantExists(grant)).toBe(false);
  });

  it('changing the password also ends OAuth grants', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('revoked'));
    const grant = await fakeOAuthGrant(user.did);
    const res = await xrpcAuthPost('net.openfederation.account.changePassword', user.accessJwt, {
      currentPassword: 'TestPassword123!', newPassword: 'AnotherPassword456!',
    });
    expect(res.status).toBe(200);
    expect(await grantExists(grant)).toBe(false);
  });

  it('suspending an account ends its OAuth grants', async () => {
    if (!plc) return;
    const { getAdminToken } = await import('./helpers.js');
    const user = await createTestUser(uniqueHandle('revoked'));
    const grant = await fakeOAuthGrant(user.did);
    const res = await xrpcAuthPost('com.atproto.admin.updateSubjectStatus', await getAdminToken(), {
      subject: { $type: 'com.atproto.admin.defs#repoRef', did: user.did }, deactivated: { applied: true, ref: 'test' },
    });
    expect(res.status).toBe(200);
    expect(await grantExists(grant)).toBe(false);
  });

  it('will not mint a service-auth token addressed to this PDS itself', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('revoked'));
    const self = await xrpcAuthGet('com.atproto.server.getServiceAuth', user.accessJwt, { aud: config.pds.serviceDid });
    expect(self.status).toBe(400);
    const other = await xrpcAuthGet('com.atproto.server.getServiceAuth', user.accessJwt, { aud: 'did:web:other-pds.example' });
    expect(other.status).toBe(200);
  });
});
