/**
 * The demo PLC directory's reset (plc-server/demo-reset.js,
 * docs/DEMO-SERVERS.md): its guards, and the wipe against a real PLC schema
 * built by @did-plc/server's own migrations in a scratch schema of the test
 * database.
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import { Pool } from 'pg';

const require = createRequire(import.meta.url);
const demo = require('../../plc-server/demo-reset.js');
const { Database } = require('@did-plc/server');

const DEMO_ENV = { DEMO_MODE: 'true', PLC_PUBLIC_URL: 'https://plc.demo.openfederation.net' };

describe('the guards', () => {
  it('pass for a demo directory', () => {
    expect(demo.demoStartupProblems(DEMO_ENV)).toEqual([]);
    expect(demo.demoStartupProblems({ DEMO_MODE: 'true', PLC_PUBLIC_URL: 'https://sandbox-plc.example.org', DEMO_ALLOWED_HOSTNAME: 'sandbox-plc.example.org' })).toEqual([]);
  });

  it('change nothing without DEMO_MODE', () => {
    expect(demo.demoStartupProblems({})).toEqual([]);
    expect(demo.demoStartupProblems({ PLC_PUBLIC_URL: 'https://plc.openfederation.net' })).toEqual([]);
  });

  it('refuse the production directories, a missing public URL and a host without "demo"', () => {
    for (const url of ['https://plc.openfederation.net', 'https://PLC.directory.', 'https://plc.directory/']) {
      expect(demo.demoStartupProblems({ DEMO_MODE: 'true', PLC_PUBLIC_URL: url, DEMO_ALLOWED_HOSTNAME: 'plc.openfederation.net' }).join(' '), url).toMatch(/production/);
    }
    expect(demo.demoStartupProblems({ DEMO_MODE: 'true' }).join(' ')).toMatch(/PLC_PUBLIC_URL/);
    expect(demo.demoStartupProblems({ DEMO_MODE: 'true', PLC_PUBLIC_URL: 'https://plc.example.org' }).join(' ')).toMatch(/demo/);
  });

  it('stop on a DEMO_MODE or schedule it cannot read', () => {
    expect(demo.demoStartupProblems({ DEMO_MODE: '1' }).join(' ')).toMatch(/DEMO_MODE/);
    expect(demo.demoStartupProblems({ ...DEMO_ENV, DEMO_RESET_SCHEDULE: '0 25 * * *' }).join(' ')).toMatch(/DEMO_RESET_SCHEDULE/);
  });

  it('reads the schedule like the PDS does', () => {
    const next = demo.nextCronRun(demo.parseCron('0 3 * * *'), new Date('2026-11-15T03:00:00Z'));
    expect(next.toISOString()).toBe('2026-11-16T03:00:00.000Z');
  });
});

describe('the timer', () => {
  afterEach(() => { demo.stopDemoResetScheduler(); vi.useRealTimers(); });

  it('runs the reset at the scheduled minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T02:59:00Z'));
    const reset = vi.fn(async () => {});
    expect(demo.startDemoResetScheduler({ env: DEMO_ENV, reset })).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('never starts without demo mode', () => {
    expect(demo.startDemoResetScheduler({ env: {}, reset: async () => {} })).toBe(false);
  });
});

describe('the gate', () => {
  afterEach(() => demo.setResettingForTests(false));
  it('answers 503 DemoResetting while resetting, and passes requests otherwise', () => {
    const res = { headers: {} as Record<string, string>, code: 0, body: null as unknown,
      setHeader(k: string, v: string) { this.headers[k] = v; },
      status(c: number) { this.code = c; return this; },
      json(b: unknown) { this.body = b; return this; } };
    const next = vi.fn();
    demo.resetGate({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    demo.setResettingForTests(true);
    demo.resetGate({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.code).toBe(503);
    expect((res.body as { error: string }).error).toBe('DemoResetting');
  });
});

describe('the wipe', () => {
  const SCHEMA = 'plc_demo_reset_test';
  const url = `postgres://${encodeURIComponent(process.env.DB_USER || 'postgres')}:${encodeURIComponent(process.env.DB_PASSWORD || '')}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME}`;
  let pool: Pool;
  let plcDb: { migrateToLatestOrThrow(): Promise<unknown>; close(): Promise<void> };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    plcDb = Database.postgres({ url, schema: SCHEMA });
    await plcDb.migrateToLatestOrThrow();
  });
  afterAll(async () => {
    demo.setResettingForTests(false);
    await plcDb?.close();
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  async function rows(table: string): Promise<number> {
    return parseInt((await pool.query(`SELECT COUNT(*) AS n FROM ${SCHEMA}.${table}`)).rows[0].n, 10);
  }

  it('refuses, touching nothing, when a guard fails', async () => {
    await pool.query(
      `INSERT INTO ${SCHEMA}.operations (did, operation, cid, nullified, "createdAt") VALUES ($1, $2, $3, false, NOW())`,
      ['did:plc:demoresettest0000000000a', JSON.stringify({ type: 'plc_operation' }), 'bafyreidemoresettest'],
    );
    const exit = vi.fn();
    const outcome = await demo.runDemoReset({
      env: { DEMO_MODE: 'true', PLC_PUBLIC_URL: 'https://plc.openfederation.net' },
      getPool: () => pool, schema: SCHEMA, exit, sleep: async () => {},
    });
    expect(outcome).toBe('refused');
    expect(exit).not.toHaveBeenCalled();
    expect(await rows('operations')).toBe(1);
  });

  it('empties the operations, keeps the migration ledger, then exits non-zero', async () => {
    const migrations = await rows('kysely_migration');
    expect(migrations).toBeGreaterThan(0);
    expect(await rows('operations')).toBeGreaterThan(0);
    const exit = vi.fn();
    const outcome = await demo.runDemoReset({ env: DEMO_ENV, getPool: () => pool, schema: SCHEMA, exit, sleep: async () => {} });
    expect(outcome).toBe('reset');
    expect(await rows('operations')).toBe(0);
    expect(await rows('kysely_migration')).toBe(migrations);
    expect(exit).toHaveBeenCalledWith(demo.EXIT_CODE);
    expect(demo.EXIT_CODE).not.toBe(0);
    expect(demo.isResetting()).toBe(true);
  });
});
