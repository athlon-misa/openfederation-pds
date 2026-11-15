/**
 * The demo server's nightly reset (docs/DEMO-SERVERS.md): every application
 * table emptied, the blobs deleted, then the process exits for the platform
 * to restart it. Called directly with an injected exit and no waiting.
 *
 * This wipes the test database, so it ends by putting the bootstrap admin
 * back, as tests/api/setup.ts does for every file.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { xrpcGet, createTestUser, api } from './helpers.js';
import { query } from '../../src/db/client.js';
import { runDemoReset, isDemoResetting, setDemoResettingForTests, type DemoGuardInput } from '../../src/demo/demo-mode.js';
import { ensureBootstrapAdmin } from '../../src/auth/bootstrap.js';

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
  it('empties every application table, keeps the migration ledger, deletes the blobs, then exits non-zero', async () => {
    await createTestUser(`demo-wipe-${Date.now().toString(36)}`);
    expect((await applicationTablesWithRows()).length).toBeGreaterThan(0);
    // tests/api/setup.ts applies the migrations without the ledger a real
    // start keeps (src/db/migrate.ts), so give it one row to keep.
    ledgerExisted = (await query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t !== null;
    await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await query(`INSERT INTO schema_migrations (filename) VALUES ('migrate-000-demo-reset-test.sql') ON CONFLICT DO NOTHING`);
    const migrations = await count('schema_migrations');
    expect(migrations).toBeGreaterThan(0);

    const exit = vi.fn();
    const sleep = vi.fn(async () => {});
    const seenWhileWiping: boolean[] = [];
    const outcome = await runDemoReset({
      env: { DEMO_MODE: 'true' }, guard: passing(blobDir), exit, sleep,
      onPhase: () => seenWhileWiping.push(isDemoResetting()),
    });

    expect(outcome).toBe('reset');
    expect(await applicationTablesWithRows()).toEqual([]);
    expect(await count('schema_migrations')).toBe(migrations);
    expect(existsSync(blobDir)).toBe(true);
    expect(readdirSync(blobDir)).toEqual([]);
    expect(seenWhileWiping.length).toBeGreaterThan(0);
    expect(seenWhileWiping.every(Boolean)).toBe(true);
    expect(sleep).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit.mock.calls[0][0]).not.toBe(0);
  });
});
