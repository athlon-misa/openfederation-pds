/**
 * The dashboard's default appearance (DEFAULT_APPEARANCE), a server setting
 * in the setup wizard and on Admin, Server settings, published in
 * getPublicConfig as appearance.defaultPreset. A person's own choice in the
 * dashboard always wins over it (tests/web/appearance.test.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { xrpcGet, xrpcAuthGet, xrpcAuthPost, getAdminToken } from './helpers.js';
import { query } from '../../src/db/client.js';
import {
  resolveRuntimeSettings, encodeSetting, refreshRuntimeSettings, runtimeSettings, SettingsError, APPEARANCE_PRESETS,
} from '../../src/settings/runtime-settings.js';
import { RUNTIME_SETTING_ENV_VARS } from '../../src/settings/keys.js';

const UPDATE = 'net.openfederation.admin.updateServerSettings';
const GET = 'net.openfederation.admin.getServerSettings';
const PUBLIC = 'net.openfederation.server.getPublicConfig';

const TOUCHED = [...RUNTIME_SETTING_ENV_VARS, 'OPENFEDERATION_PROFILE'] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

describe('the setting', () => {
  it('offers the dashboard presets, opennewsrooms included', () => {
    expect([...APPEARANCE_PRESETS]).toEqual(['pds-basic', 'openfederation', 'opennewsrooms']);
  });

  it('is openfederation unless something says otherwise, for both profiles too', () => {
    for (const env of [{}, { OPENFEDERATION_PROFILE: 'community' }, { OPENFEDERATION_PROFILE: 'privacy' }]) {
      expect(resolveRuntimeSettings(env, {}, {}).settings.appearance.defaultPreset).toBe('openfederation');
    }
  });

  it('follows the usual precedence: environment, admin, setup file, default', () => {
    expect(resolveRuntimeSettings({}, {}, { DEFAULT_APPEARANCE: 'pds-basic' })).toMatchObject({
      settings: { appearance: { defaultPreset: 'pds-basic' } }, sources: { defaultAppearance: 'setup' },
    });
    expect(resolveRuntimeSettings({}, { DEFAULT_APPEARANCE: 'opennewsrooms' }, { DEFAULT_APPEARANCE: 'pds-basic' })).toMatchObject({
      settings: { appearance: { defaultPreset: 'opennewsrooms' } }, sources: { defaultAppearance: 'admin' },
    });
    expect(resolveRuntimeSettings({ DEFAULT_APPEARANCE: 'pds-basic' }, { DEFAULT_APPEARANCE: 'opennewsrooms' }, {})).toMatchObject({
      settings: { appearance: { defaultPreset: 'pds-basic' } }, sources: { defaultAppearance: 'environment' },
    });
  });

  it('an unknown value in the environment is not fatal: a warning, and the built-in default', () => {
    expect(resolveRuntimeSettings({ DEFAULT_APPEARANCE: 'neon' }, {}, {}).settings.appearance.defaultPreset).toBe('openfederation');
  });

  it('an admin may choose only one of the presets', () => {
    expect(encodeSetting('defaultAppearance', 'opennewsrooms')).toBe('opennewsrooms');
    for (const bad of ['neon', '<script>', 1, null, ['pds-basic']]) {
      expect(() => encodeSetting('defaultAppearance', bad)).toThrow(SettingsError);
    }
  });
});

describe('the admin endpoints and the public config', () => {
  let adminToken: string;
  beforeAll(async () => { adminToken = await getAdminToken(); });
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

  it('the public config says which preset the dashboard starts with, and follows a change at once', async () => {
    expect((await xrpcGet(PUBLIC)).body.appearance).toEqual({ defaultPreset: 'openfederation' });
    const res = await update({ defaultAppearance: 'pds-basic' });
    expect(res.status).toBe(200);
    expect(runtimeSettings().appearance.defaultPreset).toBe('pds-basic');
    expect((await xrpcGet(PUBLIC)).body.appearance).toEqual({ defaultPreset: 'pds-basic' });
    const audit = (await query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit_log WHERE action = 'server.settings.update' AND target_id = 'DEFAULT_APPEARANCE' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(audit.meta).toMatchObject({ setting: 'defaultAppearance', before: 'openfederation', after: 'pds-basic' });
  });

  it('an invalid preset is refused and nothing is saved', async () => {
    const res = await update({ defaultAppearance: 'neon' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'InvalidSetting', setting: 'defaultAppearance' });
    expect((await query('SELECT 1 FROM server_settings')).rows).toHaveLength(0);
  });

  it('set by the environment: fixed, and an admin\'s change is refused', async () => {
    process.env.DEFAULT_APPEARANCE = 'opennewsrooms';
    await refreshRuntimeSettings();
    const get = await xrpcAuthGet(GET, adminToken);
    expect(get.body.settings.find((s: { id: string }) => s.id === 'defaultAppearance'))
      .toMatchObject({ value: 'opennewsrooms', source: 'environment', fixed: true, envVar: 'DEFAULT_APPEARANCE' });
    expect((await update({ defaultAppearance: 'pds-basic' })).body.error).toBe('SettingFixedByEnvironment');
    expect((await xrpcGet(PUBLIC)).body.appearance.defaultPreset).toBe('opennewsrooms');
  });
});
