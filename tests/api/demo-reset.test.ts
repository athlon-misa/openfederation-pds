/**
 * The demo server's nightly reset (docs/DEMO-SERVERS.md): every application
 * table emptied, the blobs deleted, every in-memory cache cleared and the
 * start-up seeding run again, all in this process; exiting (code 75) is only
 * the fallback when that fresh start fails. Called directly with an injected
 * exit and no waiting.
 *
 * This wipes the test database, so it ends by putting the bootstrap admin
 * back, as tests/api/setup.ts does for every file.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MemoryCache } from '@atproto/identity';
import { xrpcGet, xrpcAuthPost, createTestUser, api, isPLCAvailable, getAdminHandle } from './helpers.js';
import { query, withTransaction } from '../../src/db/client.js';
import {
  runDemoReset, isDemoResetting, setDemoResettingForTests, DEMO_RESET_EXIT_CODE, type DemoGuardInput,
} from '../../src/demo/demo-mode.js';
import { ensureBootstrapAdmin } from '../../src/auth/bootstrap.js';
import { getKeypairForDid } from '../../src/repo/keypair-utils.js';
import { getCachedKeypair } from '../../src/auth/keypair-cache.js';
import { getDidResolver } from '../../src/identity/did-resolver.js';
import { getCachedAuthContext, setCachedAuthContext } from '../../src/auth/auth-context-cache.js';
import { blockCacheGet, blockCacheSet } from '../../src/repo/block-cache.js';
import { runtimeSettings } from '../../src/settings/runtime-settings.js';
import { redeemToken } from '../../src/identity/pseudonym/tokens.js';
import { importTokenPublicKey, blindTokens, finalizeTokens } from '../../packages/openfederation-pseudonym/src/tokens.js';
import { currentEpoch } from '../../packages/openfederation-pseudonym/src/formats.js';

const passing = (blobPath: string): DemoGuardInput => ({
  plcDirectoryUrl: 'http://localhost:2582',
  pdsHostname: 'demo.openfederation.test',
  pdsServiceUrl: 'https://demo.openfederation.test',
  allowedHostname: '',
  blobStorage: 'local',
  blobPath,
  cwd: process.cwd(),
  home: '/nonexistent-home',
});

async function count(table: string): Promise<number> {
  return parseInt((await query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n, 10);
}

async function applicationTablesWithRows(): Promise<string[]> {
  const tables = (await query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  )).rows.map((r) => r.tablename);
  const out: string[] = [];
  for (const t of tables) if (await count(`"${t}"`) > 0) out.push(t);
  return out;
}

let blobDir: string;
beforeEach(() => {
  blobDir = mkdtempSync(join(tmpdir(), 'demo-blobs-'));
  mkdirSync(join(blobDir, 'bafkreia'), { recursive: true });
  writeFileSync(join(blobDir, 'bafkreia', 'bafkreiaxyz'), 'blob');
  writeFileSync(join(blobDir, 'bafkreia', 'bafkreiaxyz.meta'), 'image/png');
});
afterEach(() => {
  setDemoResettingForTests(false);
  rmSync(blobDir, { recursive: true, force: true });
});
let ledgerExisted = true;
afterAll(async () => {
  if (ledgerExisted) await query(`DELETE FROM schema_migrations WHERE filename = 'migrate-000-demo-reset-test.sql'`).catch(() => undefined);
  else await query('DROP TABLE IF EXISTS schema_migrations');
  await ensureBootstrapAdmin();
});

describe('refusing', () => {
  it('does nothing at all without DEMO_MODE=true', async () => {
    await createTestUser(`demo-keep-${Date.now().toString(36)}`);
    const before = await count('users');
    const exit = vi.fn();
    const outcome = await runDemoReset({ env: {}, guard: passing(blobDir), exit, sleep: async () => {} });
    expect(outcome).toBe('refused');
    expect(exit).not.toHaveBeenCalled();
    expect(await count('users')).toBe(before);
    expect(existsSync(join(blobDir, 'bafkreia', 'bafkreiaxyz'))).toBe(true);
    expect(isDemoResetting()).toBe(false);
  });

  for (const [what, change] of [
    ['the production PLC directory', { plcDirectoryUrl: 'https://plc.openfederation.net' }],
    ['a hostname that is not a demo one', { pdsHostname: 'pds.openfederation.net', pdsServiceUrl: 'https://pds.openfederation.net' }],
    ['S3 blob storage', { blobStorage: 's3' as const }],
  ] as const) {
    it(`does nothing at all with ${what}`, async () => {
      const before = await count('users');
      const exit = vi.fn();
      const outcome = await runDemoReset({ env: { DEMO_MODE: 'true' }, guard: { ...passing(blobDir), ...change }, exit, sleep: async () => {} });
      expect(outcome).toBe('refused');
      expect(exit).not.toHaveBeenCalled();
      expect(await count('users')).toBe(before);
      expect(existsSync(join(blobDir, 'bafkreia', 'bafkreiaxyz'))).toBe(true);
    });
  }
});

describe('while resetting', () => {
  it('answers 503 DemoResetting, except /health', async () => {
    setDemoResettingForTests(true);
    const res = await xrpcGet('net.openfederation.server.getPublicConfig');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DemoResetting');
    expect(res.headers['retry-after']).toBeDefined();
    expect((await api.get('/health')).status).toBe(200);
    setDemoResettingForTests(false);
    expect((await xrpcGet('net.openfederation.server.getPublicConfig')).status).toBe(200);
  });
});

describe('the public config', () => {
  it('says this is not a demo server unless DEMO_MODE=true', async () => {
    const saved = process.env.DEMO_MODE;
    try {
      delete process.env.DEMO_MODE;
      expect((await xrpcGet('net.openfederation.server.getPublicConfig')).body.demo).toEqual({ enabled: false });
      process.env.DEMO_MODE = 'true';
      const demo = (await xrpcGet('net.openfederation.server.getPublicConfig')).body.demo;
      expect(demo.enabled).toBe(true);
      expect(demo.resetSchedule).toBe('0 3 * * *');
      expect(new Date(demo.nextResetAt).getTime()).toBeGreaterThan(Date.now());
    } finally {
      if (saved === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = saved;
    }
  });
});

describe('the wipe', () => {
  async function keepOneMigrationRow(): Promise<number> {
    // tests/api/setup.ts applies the migrations without the ledger a real
    // start keeps (src/db/migrate.ts), so give it one row to keep.
    ledgerExisted = (await query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t !== null;
    await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await query(`INSERT INTO schema_migrations (filename) VALUES ('migrate-000-demo-reset-test.sql') ON CONFLICT DO NOTHING`);
    return count('schema_migrations');
  }

  async function collectPasses(accessJwt: string) {
    const keys = (await xrpcGet('net.openfederation.pseudonym.getTokenKeys')).body.keys;
    const epoch = currentEpoch();
    const publicKey = keys.find((k: { epoch: string }) => k.epoch === epoch).publicKey as string;
    const pub = await importTokenPublicKey(publicKey);
    const pending = await blindTokens(pub, epoch, runtimeSettings().pseudonym.tokensPerEpoch);
    const res = await xrpcAuthPost('net.openfederation.pseudonym.collectTokens', accessJwt, { epoch, blindedMessages: pending.blinded });
    return { res, pub, pending, publicKey };
  }

  it('empties every application table, keeps the migration ledger, deletes the blobs, and keeps serving without exiting', async () => {
    if (!(await isPLCAvailable())) return;
    // Before: an account that wrote to its repo (its signing key is cached),
    // collected pseudonym passes and resolved its DID.
    const before = await createTestUser(`demo-wipe-${Date.now().toString(36)}`);
    const passes = await collectPasses(before.accessJwt);
    expect(passes.res.status).toBe(200);
    const [oldPass] = await finalizeTokens(passes.pub, passes.pending, passes.res.body.blindSignatures);
    await getKeypairForDid(before.did);
    expect(getCachedKeypair(before.did)).not.toBeNull();
    await getDidResolver().resolve(before.did);
    expect(await (getDidResolver().cache as MemoryCache).checkCache(before.did)).not.toBeNull();
    setCachedAuthContext('oauth', before.did, { userId: 'x', did: before.did, handle: before.handle, email: '', roles: ['admin'], status: 'approved' } as never);
    blockCacheSet(before.did, 'bafyreidemoresetstaleblock', new Uint8Array([1, 2, 3]));
    runtimeSettings().identity.deviceSigningAllowed = !runtimeSettings().identity.deviceSigningAllowed;
    const settingsBefore = JSON.stringify(runtimeSettings());
    expect((await applicationTablesWithRows()).length).toBeGreaterThan(0);
    const migrations = await keepOneMigrationRow();
    expect(migrations).toBeGreaterThan(0);

    const exit = vi.fn();
    const sleep = vi.fn(async () => {});
    const seenWhileWiping: boolean[] = [];
    const outcome = await runDemoReset({
      env: { DEMO_MODE: 'true' }, guard: passing(blobDir), exit, sleep,
      onPhase: () => seenWhileWiping.push(isDemoResetting()),
    });

    expect(outcome).toBe('reset');
    expect(exit).not.toHaveBeenCalled();
    expect(isDemoResetting()).toBe(false);
    expect(seenWhileWiping.length).toBeGreaterThan(0);
    expect(seenWhileWiping.every(Boolean)).toBe(true);
    expect(sleep).toHaveBeenCalled();

    // Everything is gone but the ledger and what start-up creates.
    const left = await applicationTablesWithRows();
    expect(left.filter((t) => !['users', 'user_roles', 'audit_log'].includes(t))).toEqual([]);
    expect(await count('schema_migrations')).toBe(migrations);
    expect(existsSync(blobDir)).toBe(true);
    expect(readdirSync(blobDir)).toEqual([]);

    // Start-up seeding ran again: the bootstrap admin is back, and only it.
    const users = (await query<{ handle: string }>('SELECT handle FROM users')).rows.map((r) => r.handle);
    expect(users).toEqual([getAdminHandle()]);

    // Nothing in memory still answers for the deleted rows.
    expect(getCachedKeypair(before.did)).toBeNull();
    await expect(getKeypairForDid(before.did)).rejects.toThrow(/No signing key/);
    expect(await (getDidResolver().cache as MemoryCache).checkCache(before.did)).toBeNull();
    expect(getCachedAuthContext('oauth', before.did)).toBeNull();
    expect(blockCacheGet(before.did, 'bafyreidemoresetstaleblock')).toBeUndefined();
    expect(JSON.stringify(runtimeSettings())).not.toBe(settingsBefore);
    // A pass collected before the reset was signed by a key the reset deleted.
    expect(await withTransaction((tx) => redeemToken(tx, oldPass))).toBe('invalid');

    // And the server works as on a fresh start.
    expect((await api.get('/health')).status).toBe(200);
    expect((await xrpcGet('net.openfederation.server.getPublicConfig')).status).toBe(200);
    const after = await createTestUser(`demo-after-${Date.now().toString(36)}`);
    expect(after.did).toMatch(/^did:plc:/);
    const fresh = await collectPasses(after.accessJwt);
    expect(fresh.res.status).toBe(200);
    expect(fresh.publicKey).not.toBe(passes.publicKey);
    const [newPass] = await finalizeTokens(fresh.pub, fresh.pending, fresh.res.body.blindSignatures);
    expect(await withTransaction((tx) => redeemToken(tx, newPass))).toBe('ok');
  });

  it('exits with code 75 when the fresh start cannot be completed, and keeps refusing requests', async () => {
    await keepOneMigrationRow();
    const exit = vi.fn();
    const outcome = await runDemoReset({
      env: { DEMO_MODE: 'true' }, guard: passing(blobDir), exit, sleep: async () => {},
      seed: async () => { throw new Error('seeding failed'); },
    });
    expect(outcome).toBe('exited');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(DEMO_RESET_EXIT_CODE);
    expect(DEMO_RESET_EXIT_CODE).toBe(75);
    // The gate stays up: never serve with half-restored state.
    expect(isDemoResetting()).toBe(true);
    expect((await xrpcGet('net.openfederation.server.getPublicConfig')).status).toBe(503);
  });
});
