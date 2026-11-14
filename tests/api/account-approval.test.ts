/**
 * Approving new accounts automatically (ACCOUNT_APPROVAL), a server setting
 * in the setup wizard and on Admin, Server settings.
 *
 * manual (the default): every new local account waits for an admin.
 * automatic: it is approved when it is created, audited as an approval with
 * no person as the actor ({ via: 'automatic' }), and can sign in and collect
 * pen-name passes straight away. Invite-only sign-up still applies.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  xrpcGet, xrpcPost, xrpcAuthGet, xrpcAuthPost, getAdminToken, isPLCAvailable, uniqueHandle,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import {
  resolveRuntimeSettings, encodeSetting, refreshRuntimeSettings, runtimeSettings, SettingsError,
} from '../../src/settings/runtime-settings.js';
import { RUNTIME_SETTING_ENV_VARS } from '../../src/settings/keys.js';
import { PgAccountStore } from '../../src/oauth/oauth-store.js';
import { importTokenPublicKey, blindTokens } from '../../packages/openfederation-pseudonym/src/tokens.js';
import { currentEpoch } from '../../packages/openfederation-pseudonym/src/formats.js';

const UPDATE = 'net.openfederation.admin.updateServerSettings';
const GET = 'net.openfederation.admin.getServerSettings';
const PASSWORD = 'TestPassword123!';

const TOUCHED = [...RUNTIME_SETTING_ENV_VARS, 'OPENFEDERATION_PROFILE'] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

function freeEnv() { for (const k of TOUCHED) delete process.env[k]; }
function restoreEnv() {
  for (const k of TOUCHED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}
async function clearAdminSettings() {
  await query('DELETE FROM server_settings');
  await refreshRuntimeSettings();
}

describe('the setting', () => {
  it('is manual unless something says otherwise, for both profiles too', () => {
    expect(resolveRuntimeSettings({}, {}, {}).settings.accountApproval).toBe('manual');
    expect(resolveRuntimeSettings({ OPENFEDERATION_PROFILE: 'community' }, {}, {}).settings.accountApproval).toBe('manual');
    expect(resolveRuntimeSettings({ OPENFEDERATION_PROFILE: 'privacy' }, {}, {}).settings.accountApproval).toBe('manual');
  });

  it('follows the usual precedence: environment, admin, setup file, default', () => {
    expect(resolveRuntimeSettings({}, {}, { ACCOUNT_APPROVAL: 'automatic' })).toMatchObject({
      settings: { accountApproval: 'automatic' }, sources: { accountApproval: 'setup' },
    });
    expect(resolveRuntimeSettings({}, { ACCOUNT_APPROVAL: 'manual' }, { ACCOUNT_APPROVAL: 'automatic' })).toMatchObject({
      settings: { accountApproval: 'manual' }, sources: { accountApproval: 'admin' },
    });
    expect(resolveRuntimeSettings({ ACCOUNT_APPROVAL: 'automatic' }, { ACCOUNT_APPROVAL: 'manual' }, {})).toMatchObject({
      settings: { accountApproval: 'automatic' }, sources: { accountApproval: 'environment' },
    });
  });

  it('an invalid value in the environment stops the server, as at start-up', () => {
    expect(() => resolveRuntimeSettings({ ACCOUNT_APPROVAL: 'auto' }, {}, {})).toThrow(/ACCOUNT_APPROVAL/);
  });

  it('an admin may set manual or automatic, nothing else', () => {
    expect(encodeSetting('accountApproval', 'automatic')).toBe('automatic');
    expect(encodeSetting('accountApproval', 'manual')).toBe('manual');
    for (const bad of ['auto', true, '', null]) {
      expect(() => encodeSetting('accountApproval', bad)).toThrow(SettingsError);
    }
  });
});

describe('new accounts', () => {
  let adminToken: string;
  let plc = false;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    adminToken = await getAdminToken();
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
  const invite = async () => (await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 })).body.code as string;
  const register = (handle: string, inviteCode?: string) => xrpcPost('net.openfederation.account.register', {
    handle, email: `${handle}@test.local`, password: PASSWORD, ...(inviteCode ? { inviteCode } : {}),
  });
  const row = async (handle: string) => (await query<{ id: string; status: string; approved_at: Date | null; approved_by: string | null }>(
    'SELECT id, status, approved_at, approved_by FROM users WHERE handle = $1', [handle])).rows[0];

  it('manual: a new account waits for an admin, and cannot sign in', async () => {
    if (!plc) return;
    const handle = uniqueHandle('apm');
    const res = await register(handle, await invite());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(await row(handle)).toMatchObject({ status: 'pending', approved_at: null });
    const login = await xrpcPost('com.atproto.server.createSession', { identifier: handle, password: PASSWORD });
    expect(login.status).not.toBe(200);
  });

  it('automatic, switched on at runtime: approved at once, signs in, collects pen-name passes, and is audited', async () => {
    if (!plc) return;
    expect((await update({ accountApproval: 'automatic' })).status).toBe(200);
    expect(runtimeSettings().accountApproval).toBe('automatic');

    const handle = uniqueHandle('apa');
    const res = await register(handle, await invite());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('approved');
    const user = await row(handle);
    expect(user.status).toBe('approved');
    expect(user.approved_at).not.toBeNull();
    // Nobody approved it: there is no person to name.
    expect(user.approved_by).toBeNull();

    const audit = (await query<{ actor_id: string | null; meta: Record<string, unknown> }>(
      `SELECT actor_id, meta FROM audit_log WHERE action = 'account.approve' AND target_id = $1`, [user.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBeNull();
    expect(audit[0].meta).toMatchObject({ via: 'automatic', setting: 'ACCOUNT_APPROVAL', handle });

    const login = await xrpcPost('com.atproto.server.createSession', { identifier: handle, password: PASSWORD });
    expect(login.status).toBe(200);
    const keys = (await xrpcGet('net.openfederation.pseudonym.getTokenKeys')).body.keys;
    const epoch = currentEpoch();
    const pub = await importTokenPublicKey(keys.find((k: { epoch: string }) => k.epoch === epoch).publicKey);
    const pending = await blindTokens(pub, epoch, runtimeSettings().pseudonym.tokensPerEpoch);
    const passes = await xrpcAuthPost('net.openfederation.pseudonym.collectTokens', login.body.accessJwt, { epoch, blindedMessages: pending.blinded });
    expect(passes.status).toBe(200);

    // And back to manual, again without a restart.
    expect((await update({ accountApproval: null })).status).toBe(200);
    const next = uniqueHandle('apb');
    expect((await register(next, await invite())).body.status).toBe('pending');
  });

  it('automatic does not open sign-up: invite-only still asks for a code', async () => {
    if (!plc) return;
    expect((await update({ accountApproval: 'automatic', inviteRequired: true })).status).toBe(200);
    const res = await register(uniqueHandle('api'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('InviteRequired');
  });

  it('automatic with open sign-up: approved without an invite', async () => {
    if (!plc) return;
    expect((await update({ accountApproval: 'automatic', inviteRequired: false })).status).toBe(200);
    const handle = uniqueHandle('apo');
    const res = await register(handle);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('approved');
  });

  it('OAuth sign-up follows the setting too', async () => {
    if (!plc) return;
    const store = new PgAccountStore();
    const sign = async () => {
      const handle = uniqueHandle('apx');
      await store.createAccount({ handle, email: `${handle}@test.local`, password: PASSWORD, inviteCode: await invite() } as never);
      return (await row(handle)).status;
    };
    expect(await sign()).toBe('pending');
    expect((await update({ accountApproval: 'automatic' })).status).toBe(200);
    expect(await sign()).toBe('approved');
  });

  it('turning it on does not approve the people already waiting', async () => {
    if (!plc) return;
    const handle = uniqueHandle('apw');
    await register(handle, await invite());
    expect((await update({ accountApproval: 'automatic' })).status).toBe(200);
    expect((await row(handle)).status).toBe('pending');
  });

  it('set by the environment: shown as fixed, and an admin\'s change is refused', async () => {
    process.env.ACCOUNT_APPROVAL = 'automatic';
    await refreshRuntimeSettings();
    const get = await xrpcAuthGet(GET, adminToken);
    expect(get.body.settings.find((s: { id: string }) => s.id === 'accountApproval'))
      .toMatchObject({ value: 'automatic', source: 'environment', fixed: true, envVar: 'ACCOUNT_APPROVAL' });
    const res = await update({ accountApproval: 'manual' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'SettingFixedByEnvironment', setting: 'accountApproval' });
    expect(runtimeSettings().accountApproval).toBe('automatic');
  });

  it('an admin\'s change is audited like any other setting', async () => {
    expect((await update({ accountApproval: 'automatic' })).status).toBe(200);
    const audit = (await query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit_log WHERE action = 'server.settings.update' AND target_id = 'ACCOUNT_APPROVAL'
       ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(audit.meta).toMatchObject({ setting: 'accountApproval', before: 'manual', after: 'automatic' });
  });
});
