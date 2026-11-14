/**
 * The settings file the setup wizard writes (#405): where it lives, that it
 * reads back exactly, that it is private, and that environment variables win.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveConfigFilePath, readConfigFile, writeConfigFile, applyConfigToEnv, serializeConfig, probeConfigLocation,
} from '../../src/setup/config-file.js';
import { generateSecrets } from '../../src/setup/secrets.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'of-setup-'));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('resolveConfigFilePath', () => {
  it('uses OPENFEDERATION_CONFIG_FILE, then the Railway volume, then ./data', () => {
    expect(resolveConfigFilePath({ OPENFEDERATION_CONFIG_FILE: '/srv/of.env', RAILWAY_VOLUME_MOUNT_PATH: '/data' }, '/app')).toBe('/srv/of.env');
    expect(resolveConfigFilePath({ OPENFEDERATION_CONFIG_FILE: 'conf/of.env' }, '/app')).toBe('/app/conf/of.env');
    expect(resolveConfigFilePath({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }, '/app')).toBe('/data/openfederation.env');
    expect(resolveConfigFilePath({}, '/app')).toBe('/app/data/openfederation.env');
  });
});

describe('writeConfigFile / readConfigFile', () => {
  it('round-trips generated secrets and awkward values exactly, readable by the owner only', () => {
    const path = join(tempDir(), 'nested', 'openfederation.env');
    const values = {
      ...generateSecrets(),
      SMTP_PASSWORD: `p@ss w0rd "with" 'quotes' # and $HOME`,
      SMTP_FROM: 'noreply@example.org',
      CORS_ORIGINS: 'https://app.example.org',
      ALLOW_NO_EMAIL: 'true',
      EMPTY: '',
    };
    const text = writeConfigFile(path, values);
    expect(readConfigFile(path)).toEqual(values);
    expect(readFileSync(path, 'utf-8')).toBe(text);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses to replace an existing file', () => {
    const path = join(tempDir(), 'openfederation.env');
    writeConfigFile(path, { A: '1' });
    expect(() => writeConfigFile(path, { A: '2' })).toThrow(/already exists/);
    expect(readConfigFile(path)).toEqual({ A: '1' });
  });

  it('refuses values that would not survive (line breaks) and bad names', () => {
    expect(() => serializeConfig({ A: 'x\ny' })).toThrow();
    expect(() => serializeConfig({ 'bad-name': 'x' })).toThrow();
  });

  it('returns null when there is no file', () => {
    expect(readConfigFile(join(tempDir(), 'missing.env'))).toBeNull();
  });

  it('probes whether the location is writable', () => {
    expect(probeConfigLocation(join(tempDir(), 'openfederation.env')).writable).toBe(true);
    const file = join(tempDir(), 'a-file');
    writeFileSync(file, 'x');
    const r = probeConfigLocation(join(file, 'openfederation.env'));
    expect(r.writable).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});

describe('applyConfigToEnv', () => {
  it('fills in only what the environment leaves unset; environment variables win', () => {
    const env: Record<string, string | undefined> = { PDS_SERVICE_URL: 'https://from-env.example', EMPTY_BUT_SET: '' };
    const applied = applyConfigToEnv({ PDS_SERVICE_URL: 'https://from-file.example', HANDLE_SUFFIX: '.example.org', EMPTY_BUT_SET: 'x' }, env);
    expect(env.PDS_SERVICE_URL).toBe('https://from-env.example');
    expect(env.EMPTY_BUT_SET).toBe('');
    expect(env.HANDLE_SUFFIX).toBe('.example.org');
    expect(applied).toEqual(['HANDLE_SUFFIX']);
  });

  it('with no settings file, nothing changes (env-configured installs)', () => {
    const dir = tempDir();
    const path = resolveConfigFilePath({}, dir);
    expect(existsSync(path)).toBe(false);
    expect(readConfigFile(path)).toBeNull();
  });
});

describe('loadSettingsFile (#410)', () => {
  it('leaves the choices an admin can change out of the environment: they are the wizard\'s initial values', async () => {
    const { loadSettingsFile } = await import('../../src/setup/launcher.js');
    const path = join(tempDir(), 'of.env');
    writeFileSync(path, 'PDS_SERVICE_URL=https://pds.example\nINVITE_REQUIRED=false\nPSEUDONYMS_ENABLED=true\nIDENTITY_CUSTODY_DEFAULT=self\n');
    const env: Record<string, string | undefined> = { OPENFEDERATION_CONFIG_FILE: path };
    loadSettingsFile(env);
    expect(env.PDS_SERVICE_URL).toBe('https://pds.example');
    expect(env.INVITE_REQUIRED).toBeUndefined();
    expect(env.PSEUDONYMS_ENABLED).toBeUndefined();
    expect(env.IDENTITY_CUSTODY_DEFAULT).toBeUndefined();
  });
});
