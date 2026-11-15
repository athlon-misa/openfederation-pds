/**
 * "Community owners may create invite codes" (COMMUNITY_OWNER_INVITES), a
 * server setting in the setup wizard and on Admin, Server settings (#403
 * review). A community invite code is also a sign-up code for this server,
 * so whether owners who are not PDS admins may make them is the operator's
 * choice. Default: off while sign-up is invite-only, on when it is open.
 * PDS admins may always make them; codes already made keep working.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  createTestUser, getAdminToken, isPLCAvailable, uniqueHandle, xrpcAuthGet, xrpcAuthPost, xrpcPost,
} from './helpers.js';
import { query } from '../../src/db/client.js';
import {
  resolveRuntimeSettings, encodeSetting, refreshRuntimeSettings, runtimeSettings, SettingsError,
} from '../../src/settings/runtime-settings.js';
import { RUNTIME_SETTING_ENV_VARS } from '../../src/settings/keys.js';
import { DEMO_SETTING_DEFAULTS } from '../../src/demo/demo-settings.js';

const UPDATE = 'net.openfederation.admin.updateServerSettings';
const GET = 'net.openfederation.admin.getServerSettings';
const CREATE = 'net.openfederation.invite.create';

const TOUCHED = [...RUNTIME_SETTING_ENV_VARS, 'OPENFEDERATION_PROFILE', 'DEMO_MODE'] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

describe('the setting', () => {
  it('defaults to off while sign-up is invite-only, on when sign-up is open', () => {
    expect(resolveRuntimeSettings({}, {}, {}).settings.communityOwnerInvites).toBe(false);
    expect(resolveRuntimeSettings({ INVITE_REQUIRED: 'true' }, {}, {}).settings.communityOwnerInvites).toBe(false);
    expect(resolveRuntimeSettings({ INVITE_REQUIRED: 'false' }, {}, {}).settings.communityOwnerInvites).toBe(true);
    // The default follows invite-only wherever that comes from.
    expect(resolveRuntimeSettings({}, { INVITE_REQUIRED: 'false' }, {}).settings.communityOwnerInvites).toBe(true);
    expect(resolveRuntimeSettings({}, {}, { INVITE_REQUIRED: 'false' }).settings.communityOwnerInvites).toBe(true);
    // Neither profile changes it.
    for (const profile of ['community', 'privacy']) {
      expect(resolveRuntimeSettings({ OPENFEDERATION_PROFILE: profile }, {}, {}).settings.communityOwnerInvites).toBe(false);
    }
  });

  it('a demo server defaults it on', () => {
    expect(DEMO_SETTING_DEFAULTS.COMMUNITY_OWNER_INVITES).toBe('true');
    expect(resolveRuntimeSettings({ DEMO_MODE: 'true' }, {}, {}).settings.communityOwnerInvites).toBe(true);
  });

  it('follows the usual precedence: environment, admin, setup file, default', () => {
    expect(resolveRuntimeSettings({}, {}, { COMMUNITY_OWNER_INVITES: 'true' })).toMatchObject({
      settings: { communityOwnerInvites: true }, sources: { communityOwnerInvites: 'setup' },
    });
    expect(resolveRuntimeSettings({}, { COMMUNITY_OWNER_INVITES: 'false' }, { COMMUNITY_OWNER_INVITES: 'true' })).toMatchObject({
      settings: { communityOwnerInvites: false }, sources: { communityOwnerInvites: 'admin' },
    });
    expect(resolveRuntimeSettings({ COMMUNITY_OWNER_INVITES: 'true' }, { COMMUNITY_OWNER_INVITES: 'false' }, {})).toMatchObject({
      settings: { communityOwnerInvites: true }, sources: { communityOwnerInvites: 'environment' },
    });
    // An explicit choice wins over the invite-only default.
    expect(resolveRuntimeSettings({ INVITE_REQUIRED: 'false' }, { COMMUNITY_OWNER_INVITES: 'false' }, {}).settings.communityOwnerInvites).toBe(false);
  });

  it('an invalid value in the environment stops the server, as at start-up', () => {
    expect(() => resolveRuntimeSettings({ COMMUNITY_OWNER_INVITES: 'yes' }, {}, {})).toThrow(/COMMUNITY_OWNER_INVITES/);
  });

  it('an admin may set it on or off, nothing else', () => {
    expect(encodeSetting('communityOwnerInvites', true)).toBe('true');
    expect(encodeSetting('communityOwnerInvites', false)).toBe('false');
    for (const bad of ['true', 1, null, 'on']) expect(() => encodeSetting('communityOwnerInvites', bad)).toThrow(SettingsError);
  });
});

describe('invite.create with a community, by setting', () => {
  let plc = false;
  let adminToken: string;
  let owner: { accessJwt: string; did: string };
  let community: string;

  beforeAll(async () => {
    plc = await isPLCAvailable();
    adminToken = await getAdminToken();
    if (!plc) return;
    owner = await createTestUser(uniqueHandle('coi-owner'));
    const res = await xrpcAuthPost('net.openfederation.community.create', owner.accessJwt, {
      handle: uniqueHandle('coi'), didMethod: 'plc', visibility: 'public', joinPolicy: 'open',
    });
    community = res.body.did;
  });
  beforeEach(async () => {
    for (const k of TOUCHED) delete process.env[k];
    await query('DELETE FROM server_settings');
    await refreshRuntimeSettings();
  });
  afterAll(async () => {
    for (const k of TOUCHED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await query('DELETE FROM server_settings');
    await refreshRuntimeSettings();
  });
  const update = (changes: Record<string, unknown>) => xrpcAuthPost(UPDATE, adminToken, { changes });

  it('off (the default under invite-only): the owner is refused, a PDS admin is not', async () => {
    if (!plc) return;
    expect(runtimeSettings().inviteRequired).toBe(true);
    expect(runtimeSettings().communityOwnerInvites).toBe(false);
    const refused = await xrpcAuthPost(CREATE, owner.accessJwt, { community });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('CommunityOwnerInvitesOff');
    expect((await xrpcAuthPost(CREATE, adminToken, { community })).status).toBe(201);
  });

  it('on: the owner may make them; turned off again, codes already made keep working', async () => {
    if (!plc) return;
    expect((await update({ communityOwnerInvites: true })).status).toBe(200);
    const made = await xrpcAuthPost(CREATE, owner.accessJwt, { community });
    expect(made.status).toBe(201);

    expect((await update({ communityOwnerInvites: false })).status).toBe(200);
    expect((await xrpcAuthPost(CREATE, owner.accessJwt, { community })).status).toBe(403);
    const handle = uniqueHandle('coi-j');
    const res = await xrpcPost('net.openfederation.account.register', {
      handle, email: `${handle}@test.local`, password: 'TestPassword123!', inviteCode: made.body.code,
    });
    expect(res.status).toBe(201);
    expect(res.body.community).toEqual({ did: community, status: 'waitingForApproval' });
  });

  it('defaults on when sign-up is open', async () => {
    if (!plc) return;
    expect((await update({ inviteRequired: false })).status).toBe(200);
    expect(runtimeSettings().communityOwnerInvites).toBe(true);
    expect((await xrpcAuthPost(CREATE, owner.accessJwt, { community })).status).toBe(201);
  });

  it('set by the environment: fixed on the settings page, and an admin\'s change is refused', async () => {
    process.env.COMMUNITY_OWNER_INVITES = 'true';
    await refreshRuntimeSettings();
    const get = await xrpcAuthGet(GET, adminToken);
    expect(get.body.settings.find((s: { id: string }) => s.id === 'communityOwnerInvites'))
      .toMatchObject({ value: true, source: 'environment', fixed: true, envVar: 'COMMUNITY_OWNER_INVITES' });
    expect((await update({ communityOwnerInvites: false })).body.error).toBe('SettingFixedByEnvironment');
    if (!plc) return;
    expect((await xrpcAuthPost(CREATE, owner.accessJwt, { community })).status).toBe(201);
  });

  it('the settings page shows the default and where it comes from', async () => {
    const get = await xrpcAuthGet(GET, adminToken);
    expect(get.body.settings.find((s: { id: string }) => s.id === 'communityOwnerInvites'))
      .toMatchObject({ value: false, source: 'default', fixed: false, fallback: false, fallbackSource: 'default' });
  });
});
