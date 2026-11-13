/**
 * Custody modes, step 1 (ADR-003, decisions 1, 2, 6): the installation's
 * policy, each account's custody_mode, and what each mode refuses.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  xrpcGet, xrpcPost, xrpcAuthGet, xrpcAuthPost, createTestUser, getAdminToken, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { resolveIdentityPolicy } from '../../src/identity/custody-policy.js';

describe('identity policy from configuration', () => {
  it('unset: everything allowed, custodial by default, pseudonyms on', () => {
    expect(resolveIdentityPolicy({})).toEqual({
      profile: null, custodyAllowed: ['custodial', 'assisted', 'self'], custodyDefault: 'custodial', pseudonymsEnabled: true,
      deviceSigningAllowed: false,
    });
  });

  it('profiles supply defaults', () => {
    expect(resolveIdentityPolicy({ OPENFEDERATION_PROFILE: 'community' })).toMatchObject({
      profile: 'community', custodyDefault: 'custodial', pseudonymsEnabled: false, deviceSigningAllowed: false,
    });
    expect(resolveIdentityPolicy({ OPENFEDERATION_PROFILE: 'privacy' })).toMatchObject({
      profile: 'privacy', custodyDefault: 'self', pseudonymsEnabled: true, deviceSigningAllowed: true,
    });
  });

  it('every setting overrides the profile', () => {
    expect(resolveIdentityPolicy({
      OPENFEDERATION_PROFILE: 'community', IDENTITY_CUSTODY_ALLOWED: 'custodial, assisted',
      IDENTITY_CUSTODY_DEFAULT: 'assisted', PSEUDONYMS_ENABLED: 'true', DEVICE_SIGNING_ALLOWED: 'true',
    })).toEqual({ profile: 'community', custodyAllowed: ['custodial', 'assisted'], custodyDefault: 'assisted', pseudonymsEnabled: true, deviceSigningAllowed: true });
    expect(resolveIdentityPolicy({ OPENFEDERATION_PROFILE: 'privacy', DEVICE_SIGNING_ALLOWED: 'false' }).deviceSigningAllowed).toBe(false);
  });

  it('refuses nonsense instead of guessing', () => {
    expect(() => resolveIdentityPolicy({ OPENFEDERATION_PROFILE: 'newsroom' })).toThrow(/OPENFEDERATION_PROFILE/);
    expect(() => resolveIdentityPolicy({ IDENTITY_CUSTODY_ALLOWED: 'custodial,banana' })).toThrow(/IDENTITY_CUSTODY_ALLOWED/);
    expect(() => resolveIdentityPolicy({ IDENTITY_CUSTODY_ALLOWED: '' })).toThrow(/IDENTITY_CUSTODY_ALLOWED/);
    expect(() => resolveIdentityPolicy({ IDENTITY_CUSTODY_ALLOWED: 'self', IDENTITY_CUSTODY_DEFAULT: 'custodial' })).toThrow(/IDENTITY_CUSTODY_DEFAULT/);
    expect(() => resolveIdentityPolicy({ PSEUDONYMS_ENABLED: 'maybe' })).toThrow(/PSEUDONYMS_ENABLED/);
    expect(() => resolveIdentityPolicy({ DEVICE_SIGNING_ALLOWED: 'yes' })).toThrow(/DEVICE_SIGNING_ALLOWED/);
  });
});

describe('custody modes on this PDS', () => {
  let plc = false;
  const saved = { ...config.identity, custodyAllowed: [...config.identity.custodyAllowed] };

  beforeAll(async () => { plc = await isPLCAvailable(); });
  afterEach(() => { Object.assign(config.identity, { ...saved, custodyAllowed: [...saved.custodyAllowed] }); });

  it('getPublicConfig publishes the policy', async () => {
    const res = await xrpcGet('net.openfederation.server.getPublicConfig');
    expect(res.status).toBe(200);
    expect(res.body.identity).toEqual({
      custodyAllowed: config.identity.custodyAllowed, custodyDefault: config.identity.custodyDefault,
      pseudonymsEnabled: config.identity.pseudonymsEnabled, deviceSigningAllowed: config.identity.deviceSigningAllowed,
    });
  });

  it('a registered account is custodial, and getSecurityLevel says so', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('cm'));
    const row = await query<{ custody_mode: string }>('SELECT custody_mode FROM users WHERE did = $1', [user.did]);
    expect(row.rows[0].custody_mode).toBe('custodial');
    const level = await xrpcAuthGet('net.openfederation.account.getSecurityLevel', user.accessJwt);
    expect(level.body.custodyMode).toBe('custodial');
  });

  it('registration refuses a custodial account when the policy does not allow custodial', async () => {
    if (!plc) return;
    config.identity.custodyAllowed = ['self'];
    config.identity.custodyDefault = 'self';
    const invite = await xrpcAuthPost('net.openfederation.invite.create', await getAdminToken(), { maxUses: 1 });
    const handle = uniqueHandle('cmno');
    const res = await xrpcPost('net.openfederation.account.register', {
      handle, email: `${handle}@test.local`, password: 'TestPassword123!', inviteCode: invite.body.code,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CustodyModeNotAllowed');
    expect((await query('SELECT 1 FROM users WHERE handle LIKE $1', [`${handle}%`])).rows).toHaveLength(0);
  });

  it('a self account is refused by the vault endpoints', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('cms'));
    await query(`UPDATE users SET custody_mode = 'self' WHERE did = $1`, [user.did]);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['net.openfederation.vault.requestShareRelease', {}],
      ['net.openfederation.vault.exportRecoveryKey', {}],
      ['net.openfederation.vault.registerEscrow', { escrowProviderDid: 'did:web:escrow.example', escrowProviderName: 'x' }],
    ];
    for (const [nsid, body] of calls) {
      const res = await xrpcAuthPost(nsid, user.accessJwt, body);
      expect(res.status, nsid).toBe(403);
      expect(res.body.error, nsid).toBe('SelfCustodyAccount');
    }
  });

  it('an assisted or self account cannot have the PDS sign a pseudonym link', async () => {
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('cml'));
    await query(`UPDATE users SET custody_mode = 'assisted' WHERE did = $1`, [user.did]);
    const res = await xrpcAuthPost('net.openfederation.pseudonym.signLink', user.accessJwt, { statement: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('SelfCustodyAccount');
  });

  it('with pseudonyms switched off, no new pseudonym can start (tokens refused)', async () => {
    if (!plc) return;
    config.identity.pseudonymsEnabled = false;
    const user = await createTestUser(uniqueHandle('cmp'));
    const res = await xrpcAuthPost('net.openfederation.pseudonym.collectTokens', user.accessJwt, { blindedMessages: [] });
    expect(res.status).toBe(501);
    const keys = await xrpcGet('net.openfederation.pseudonym.getTokenKeys');
    expect(keys.status).toBe(501);
  });
});
