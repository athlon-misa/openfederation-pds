/**
 * Admin, Server settings (#410): the wizard's choices, changeable at runtime.
 *
 * Precedence (environment > admin > setup file > profile default > built-in),
 * validation as at start-up, the effect without a restart, the audit trail,
 * admin-only access, settings fixed by the environment, and the rules between
 * settings.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  xrpcGet, xrpcAuthGet, xrpcAuthPost, getAdminToken, createTestUser, isPLCAvailable, uniqueHandle, getAdminHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import {
  resolveRuntimeSettings, encodeSetting, refreshRuntimeSettings, runtimeSettings, SettingsError,
} from '../../src/settings/runtime-settings.js';
import { splitSettingsFile, RUNTIME_SETTING_ENV_VARS } from '../../src/settings/keys.js';

const GET = 'net.openfederation.admin.getServerSettings';
const UPDATE = 'net.openfederation.admin.updateServerSettings';

/** The variables these tests touch, restored afterwards. */
const TOUCHED = [...RUNTIME_SETTING_ENV_VARS, 'OPENFEDERATION_PROFILE'] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

async function clearAdminSettings() {
  await query('DELETE FROM server_settings');
  await refreshRuntimeSettings();
}

function restoreEnv() {
  for (const k of TOUCHED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

/** No runtime setting fixed by the environment, so every one is changeable. */
function freeEnv() {
  for (const k of TOUCHED) delete process.env[k];
}

describe('precedence', () => {
  it('environment, then admin, then the setup file, then the profile, then the built-in default', () => {
    const env = { OPENFEDERATION_PROFILE: 'community', PSEUDONYM_TOKENS_PER_EPOCH: '5' };
    const admin = { PSEUDONYM_TOKENS_PER_EPOCH: '9', PSEUDONYM_PROBATION_DAYS: '3', INVITE_REQUIRED: 'false' };
    const setup = { PSEUDONYM_PROBATION_DAYS: '1', PSEUDONYM_PROBATION_DAILY_WRITES: '4', INVITE_REQUIRED: 'true' };
    const { settings, sources } = resolveRuntimeSettings(env, admin, setup);
    expect(settings.pseudonym).toEqual({ tokensPerEpoch: 5, probationDays: 3, probationDailyWrites: 4 });
    expect(settings.inviteRequired).toBe(false);
    // The community profile turns pen names off; nothing else says otherwise.
    expect(settings.identity.pseudonymsEnabled).toBe(false);
    expect(settings.migration).toEqual({ accounts: 'invite', pseudonyms: 'open', communities: 'invite' });
    expect(sources).toMatchObject({
      pseudonymTokensPerEpoch: 'environment', pseudonymProbationDays: 'admin', pseudonymProbationDailyWrites: 'setup',
      inviteRequired: 'admin', pseudonymsEnabled: 'default', migrationAccounts: 'default',
    });
  });

  it('a blank environment variable does not fix the setting', () => {
    const { sources, settings } = resolveRuntimeSettings({ FEDERATION_PEERS: '  ' }, { FEDERATION_PEERS: 'https://peer.example' }, {});
    expect(sources.federationPeers).toBe('admin');
    expect(settings.federationPeers).toEqual(['https://peer.example']);
  });

  it('the environment is still checked as at start-up', () => {
    expect(() => resolveRuntimeSettings({ PSEUDONYMS_ENABLED: 'maybe' }, {}, {})).toThrow(/PSEUDONYMS_ENABLED/);
    expect(() => resolveRuntimeSettings({ FEDERATION_PEERS: 'not a url' }, {}, {})).toThrow(/FEDERATION_PEERS/);
    expect(() => resolveRuntimeSettings({ IDENTITY_CUSTODY_ALLOWED: 'self', IDENTITY_CUSTODY_DEFAULT: 'custodial' }, {}, {}))
      .toThrow(/IDENTITY_CUSTODY_DEFAULT/);
  });

  it('the setup file: these settings are the wizard\'s initial choices, everything else goes to the environment', () => {
    const { runtime, rest } = splitSettingsFile({
      PDS_SERVICE_URL: 'https://pds.example', AUTH_JWT_SECRET: 'x', INVITE_REQUIRED: 'true', PSEUDONYMS_ENABLED: 'false',
      IDENTITY_CUSTODY_ALLOWED: 'custodial,self', IDENTITY_CUSTODY_DEFAULT: 'self', OPENFEDERATION_PROFILE: 'privacy',
    });
    expect(runtime).toEqual({ INVITE_REQUIRED: 'true', PSEUDONYMS_ENABLED: 'false', IDENTITY_CUSTODY_ALLOWED: 'custodial,self', IDENTITY_CUSTODY_DEFAULT: 'self' });
    expect(rest).toEqual({ PDS_SERVICE_URL: 'https://pds.example', AUTH_JWT_SECRET: 'x', OPENFEDERATION_PROFILE: 'privacy' });
  });
});

describe('validation of an admin\'s value', () => {
  const refused = (id: Parameters<typeof encodeSetting>[0], value: unknown) => {
    try { encodeSetting(id, value); } catch (err) { return err instanceof SettingsError ? err.code : 'other'; }
    return 'accepted';
  };

  it('accepts what start-up accepts, in the shape the dashboard sends', () => {
    expect(encodeSetting('pseudonymsEnabled', false)).toBe('false');
    expect(encodeSetting('pseudonymProbationDays', 0)).toBe('0');
    expect(encodeSetting('custodyAllowed', ['self', 'custodial'])).toBe('custodial,self');
    expect(encodeSetting('federationPeers', ['https://a.example/path', ' https://b.example '])).toBe('https://a.example/path,https://b.example');
    expect(encodeSetting('emailVerificationPolicy', 'require-for-write')).toBe('require-for-write');
  });

  it('refuses anything else, with a message', () => {
    expect(refused('pseudonymsEnabled', 'false')).toBe('InvalidSetting');
    expect(refused('pseudonymTokensPerEpoch', 0)).toBe('InvalidSetting');
    expect(refused('pseudonymTokensPerEpoch', 2.5)).toBe('InvalidSetting');
    expect(refused('pseudonymProbationDays', -1)).toBe('InvalidSetting');
    expect(refused('pseudonymProbationDailyWrites', 0)).toBe('InvalidSetting');
    expect(refused('custodyAllowed', [])).toBe('InvalidSetting');
    expect(refused('custodyAllowed', ['custodial', 'banana'])).toBe('InvalidSetting');
    expect(refused('custodyDefault', 'nobody')).toBe('InvalidSetting');
    expect(refused('emailVerificationPolicy', 'sometimes')).toBe('InvalidSetting');
    expect(refused('migrationAccounts', 'token')).toBe('InvalidSetting');
    expect(refused('migrationPseudonyms', 'invite')).toBe('InvalidSetting');
    expect(refused('federationPeers', ['ftp://peer.example'])).toBe('InvalidSetting');
    expect(refused('federationPeers', ['https://user:pw@peer.example'])).toBe('InvalidSetting');
    expect(refused('federationPeers', 'https://peer.example')).toBe('InvalidSetting');
  });
});

describe('the admin endpoints', () => {
  let adminToken: string;
  let adminId: string;
  let plc = false;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    adminToken = await getAdminToken();
    adminId = (await query<{ id: string }>('SELECT id FROM users WHERE handle = $1', [getAdminHandle()])).rows[0].id;
  });
  beforeEach(async () => {
    freeEnv();
    await clearAdminSettings();
  });
  afterAll(async () => {
    restoreEnv();
    await clearAdminSettings();
  });

  const update = (changes: Record<string, unknown>) => xrpcAuthPost(UPDATE, adminToken, { changes });
  const setting = (body: { settings: Array<{ id: string }> }, id: string) => body.settings.find((s) => s.id === id) as Record<string, unknown>;

  it('are for admins only', async () => {
    expect((await xrpcGet(GET)).status).toBe(401);
    if (!plc) return;
    const user = await createTestUser(uniqueHandle('ss'));
    const get = await xrpcAuthGet(GET, user.accessJwt);
    expect(get.status).toBe(403);
    const post = await xrpcAuthPost(UPDATE, user.accessJwt, { changes: { inviteRequired: false } });
    expect(post.status).toBe(403);
    expect((await query('SELECT 1 FROM server_settings')).rows).toHaveLength(0);
  });

  it('lists every setting with its value and where it comes from', async () => {
    const res = await xrpcAuthGet(GET, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.settings.map((s: { id: string }) => s.id)).toEqual([
      'pseudonymsEnabled', 'pseudonymTokensPerEpoch', 'pseudonymProbationDays', 'pseudonymProbationDailyWrites',
      'custodyAllowed', 'custodyDefault', 'deviceSigningAllowed', 'inviteRequired', 'emailVerificationPolicy',
      'migrationAccounts', 'migrationPseudonyms', 'migrationCommunities', 'federationPeers',
    ]);
    expect(setting(res.body, 'pseudonymTokensPerEpoch')).toMatchObject({ value: 20, source: 'default', fixed: false, envVar: 'PSEUDONYM_TOKENS_PER_EPOCH' });
    expect(res.body.refreshSeconds).toBeGreaterThan(0);
  });

  it('pen names off refuses new ones at once; on again allows them, without a restart', async () => {
    const off = await update({ pseudonymsEnabled: false });
    expect(off.status).toBe(200);
    expect(setting(off.body, 'pseudonymsEnabled')).toMatchObject({ value: false, source: 'admin' });
    expect((await xrpcGet('net.openfederation.pseudonym.getTokenKeys')).status).toBe(501);
    expect((await xrpcAuthPost('net.openfederation.pseudonym.collectTokens', adminToken, { blindedMessages: [] })).status).toBe(501);
    expect((await xrpcGet('net.openfederation.server.getPublicConfig')).body.identity.pseudonymsEnabled).toBe(false);

    const on = await update({ pseudonymsEnabled: true });
    expect(on.status).toBe(200);
    expect((await xrpcGet('net.openfederation.pseudonym.getTokenKeys')).status).toBe(200);
    expect((await xrpcGet('net.openfederation.server.getPublicConfig')).body.identity.pseudonymsEnabled).toBe(true);
  });

  it('every change is audited with the actor, the setting, before and after', async () => {
    const res = await update({ pseudonymProbationDays: 3, migrationAccounts: 'closed' });
    expect(res.status).toBe(200);
    const rows = (await query<{ actor_id: string; target_id: string; meta: Record<string, unknown> }>(
      `SELECT actor_id, target_id, meta FROM audit_log WHERE action = 'server.settings.update' AND actor_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 2`, [adminId],
    )).rows;
    const byTarget = Object.fromEntries(rows.map((r) => [r.target_id, r]));
    expect(byTarget.PSEUDONYM_PROBATION_DAYS.meta).toMatchObject({ setting: 'pseudonymProbationDays', before: 7, after: 3, reset: false });
    expect(byTarget.MIGRATION_ACCOUNTS.meta).toMatchObject({ setting: 'migrationAccounts', before: 'invite', after: 'closed' });
    expect(runtimeSettings().migration.accounts).toBe('closed');
    expect((await xrpcGet('net.openfederation.server.getPublicConfig')).body.migration.accounts).toBe('closed');
  });

  it('null drops the admin\'s change and returns to the default', async () => {
    await update({ pseudonymTokensPerEpoch: 5 });
    expect(runtimeSettings().pseudonym.tokensPerEpoch).toBe(5);
    const res = await update({ pseudonymTokensPerEpoch: null });
    expect(res.status).toBe(200);
    expect(setting(res.body, 'pseudonymTokensPerEpoch')).toMatchObject({ value: 20, source: 'default' });
    expect(res.body.changed[0]).toMatchObject({ before: 5, after: 20, reset: true });
    expect((await query('SELECT 1 FROM server_settings')).rows).toHaveLength(0);
  });

  it('a setting fixed by the environment is shown as fixed and cannot be changed', async () => {
    process.env.INVITE_REQUIRED = 'true';
    await refreshRuntimeSettings();
    const get = await xrpcAuthGet(GET, adminToken);
    expect(setting(get.body, 'inviteRequired')).toMatchObject({ value: true, source: 'environment', fixed: true });
    const res = await update({ inviteRequired: false, pseudonymProbationDays: 2 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'SettingFixedByEnvironment', setting: 'inviteRequired' });
    expect(res.body.message).toMatch(/environment/);
    // All or nothing: the other change was not applied either.
    expect(runtimeSettings().pseudonym.probationDays).toBe(7);
    expect(runtimeSettings().inviteRequired).toBe(true);
  });

  it('an invalid value refuses the whole change', async () => {
    const res = await update({ pseudonymProbationDays: 2, pseudonymTokensPerEpoch: 0 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'InvalidSetting', setting: 'pseudonymTokensPerEpoch' });
    expect((await query('SELECT 1 FROM server_settings')).rows).toHaveLength(0);
    expect((await update({ banana: true })).body.error).toBe('InvalidRequest');
    expect((await xrpcAuthPost(UPDATE, adminToken, { changes: {} })).body.error).toBe('InvalidRequest');
  });

  it('the way offered first must be offered', async () => {
    expect((await update({ custodyDefault: 'self' })).status).toBe(200);
    const res = await update({ custodyAllowed: ['custodial', 'assisted'] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'InvalidCombination', setting: 'custodyDefault' });
    expect(res.body.message).toMatch(/offered first/);
    expect(runtimeSettings().identity.custodyAllowed).toEqual(['custodial', 'assisted', 'self']);

    const both = await update({ custodyAllowed: ['custodial', 'assisted'], custodyDefault: 'assisted' });
    expect(both.status).toBe(200);
    expect(runtimeSettings().identity).toMatchObject({ custodyAllowed: ['custodial', 'assisted'], custodyDefault: 'assisted' });
    const pub = await xrpcGet('net.openfederation.server.getPublicConfig');
    expect(pub.body.identity).toMatchObject({ custodyAllowed: ['custodial', 'assisted'], custodyDefault: 'assisted' });
  });

  it('device signing needs Self or Assisted offered', async () => {
    const res = await update({ deviceSigningAllowed: true, custodyAllowed: ['custodial'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidCombination');
    expect(runtimeSettings().identity.deviceSigningAllowed).toBe(false);
    expect((await update({ deviceSigningAllowed: true })).status).toBe(200);
    const removing = await update({ custodyAllowed: ['custodial'] });
    expect(removing.status).toBe(400);
    expect(removing.body.message).toMatch(/Device signing/);
    expect((await update({ custodyAllowed: ['custodial'], deviceSigningAllowed: false })).status).toBe(200);
  });

  it('a custody mode no longer offered refuses new sign-ups in it at once', async () => {
    if (!plc) return;
    expect((await update({ custodyAllowed: ['self'], custodyDefault: 'self', inviteRequired: false })).status).toBe(200);
    const handle = uniqueHandle('ssc');
    const res = await xrpcAuthPost('net.openfederation.account.register', adminToken, {
      handle, email: `${handle}@test.local`, password: 'TestPassword123!',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CustodyModeNotAllowed');
  });

  it('federation peers take effect for discovery', async () => {
    const res = await update({ federationPeers: ['https://peer-one.example', 'https://peer-two.example/'] });
    expect(res.status).toBe(200);
    expect(runtimeSettings().federationPeers).toEqual(['https://peer-one.example', 'https://peer-two.example']);
    expect(setting(res.body, 'federationPeers')).toMatchObject({ value: ['https://peer-one.example', 'https://peer-two.example'], source: 'admin' });
  });

  it('a change made by another instance arrives with the next refresh', async () => {
    await query(`INSERT INTO server_settings (name, value) VALUES ('EMAIL_VERIFICATION_POLICY', 'require-for-login')`);
    expect(runtimeSettings().emailVerificationPolicy).toBe('advisory');
    await refreshRuntimeSettings();
    expect(runtimeSettings().emailVerificationPolicy).toBe('require-for-login');
  });

  it('saved changes that the environment later contradicts wait, and the page says why', async () => {
    expect((await update({ custodyDefault: 'self' })).status).toBe(200);
    process.env.IDENTITY_CUSTODY_ALLOWED = 'custodial';
    await refreshRuntimeSettings();
    expect(runtimeSettings().identity).toMatchObject({ custodyAllowed: ['custodial'], custodyDefault: 'custodial' });
    const res = await xrpcAuthGet(GET, adminToken);
    expect(res.body.problem).toMatch(/IDENTITY_CUSTODY_DEFAULT/);
    expect(setting(res.body, 'custodyAllowed')).toMatchObject({ fixed: true, source: 'environment' });
    delete process.env.IDENTITY_CUSTODY_ALLOWED;
    await refreshRuntimeSettings();
    expect(runtimeSettings().identity.custodyDefault).toBe('self');
  });
});
