/**
 * Demo mode: a public demo server whose data is all deleted on a schedule
 * (docs/DEMO-SERVERS.md).
 *
 * DEMO_MODE=true (environment only, never a dashboard setting) turns it on.
 * At DEMO_RESET_SCHEDULE (cron, UTC; default 03:00 every day) the server
 * refuses requests with 503 DemoResetting, empties every application table,
 * deletes its blobs, then brings this process back to a fresh start without
 * exiting (src/server/fresh-start.ts: every in-memory cache emptied, the
 * start-up seeding run again, so the bootstrap admin is back when one is
 * configured) and serves again.
 *
 * It used to exit with DEMO_RESET_EXIT_CODE and leave the restart to the
 * platform; on 2026-11-16 Railway marked one demo PDS crashed after that exit
 * and never started it again, although its restart policy was Always. The
 * exit is now only the fallback, when the fresh start itself fails: the gate
 * stays up until the process is gone, so it never serves half-restored state.
 *
 * The wipe is reachable only through runDemoReset(), which re-reads DEMO_MODE
 * and re-checks every guard itself before touching anything; the server also
 * refuses to start when DEMO_MODE=true and a guard fails. The guards:
 *   - PLC_DIRECTORY_URL is not a production directory (PRODUCTION_PLC_HOSTS):
 *     a demo's identities, and those of visitors holding their own rotation
 *     keys, must live in a demo directory that is wiped with it;
 *   - PDS_HOSTNAME and the host of PDS_SERVICE_URL contain "demo", or equal
 *     DEMO_ALLOWED_HOSTNAME;
 *   - blobs are stored locally (BLOB_STORAGE=local), in a directory that is
 *     not the filesystem root, the working directory, the home directory or
 *     a parent of one of them.
 * NODE_ENV=production is allowed: a demo server is a real deployment.
 *
 * Nothing is audited: the audit log is wiped with everything else. One line
 * is logged.
 */
import type { Request, Response, NextFunction } from 'express';
import { readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve, parse, sep, join } from 'path';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { clearKeypairCache } from '../auth/keypair-cache.js';
import { clearInMemoryState, seedStartupData } from '../server/fresh-start.js';
import { parseCron, nextCronRun, type CronSchedule } from './cron.js';

type Env = Record<string, string | undefined>;

export const DEFAULT_DEMO_RESET_SCHEDULE = '0 3 * * *';
/** EX_TEMPFAIL: "try again". Only when the in-process fresh start fails, for the platform to start the server afresh. */
export const DEMO_RESET_EXIT_CODE = 75;
/** Never a demo's PLC directory. */
export const PRODUCTION_PLC_HOSTS = ['plc.openfederation.net', 'plc.directory'] as const;
/** Never a demo PDS, whatever DEMO_ALLOWED_HOSTNAME says. */
export const PRODUCTION_PDS_HOSTS = ['pds.openfederation.net'] as const;
/** How long requests already running get before the tables are emptied. */
const DRAIN_MS = 5_000;
/** The longest a single timer waits; the schedule is re-checked after it. */
const MAX_TIMER_MS = 60 * 60 * 1000;

export interface DemoConfig {
  enabled: boolean;
  resetSchedule: string;
  cron: CronSchedule | null;
}

/** DEMO_MODE and DEMO_RESET_SCHEDULE. Throws on a value it cannot read. */
export function readDemoConfig(env: Env = process.env): DemoConfig {
  const raw = env.DEMO_MODE?.trim().toLowerCase() ?? '';
  if (raw !== '' && raw !== 'true' && raw !== 'false') {
    throw new Error(`DEMO_MODE must be "true" or "false" (got "${env.DEMO_MODE}").`);
  }
  const resetSchedule = env.DEMO_RESET_SCHEDULE?.trim() || DEFAULT_DEMO_RESET_SCHEDULE;
  if (raw !== 'true') return { enabled: false, resetSchedule, cron: null };
  let cron: CronSchedule;
  try {
    cron = parseCron(resetSchedule);
    nextCronRun(cron, new Date());
  } catch (err) {
    throw new Error(`DEMO_RESET_SCHEDULE: ${err instanceof Error ? err.message : String(err)}.`);
  }
  return { enabled: true, resetSchedule, cron };
}

export interface DemoGuardInput {
  plcDirectoryUrl: string;
  pdsHostname: string;
  pdsServiceUrl: string;
  /** DEMO_ALLOWED_HOSTNAME: a demo host whose name does not contain "demo". */
  allowedHostname: string;
  blobStorage: string;
  blobPath: string;
  cwd: string;
  home: string;
}

export function currentDemoGuardInput(env: Env = process.env): DemoGuardInput {
  return {
    plcDirectoryUrl: config.plc.directoryUrl,
    pdsHostname: config.pds.hostname,
    pdsServiceUrl: config.pds.serviceUrl,
    allowedHostname: env.DEMO_ALLOWED_HOSTNAME?.trim() || '',
    blobStorage: config.blob.storage,
    blobPath: config.blob.localPath,
    cwd: process.cwd(),
    home: homedir(),
  };
}

const normalHost = (h: string) => h.trim().toLowerCase().replace(/\.+$/, '');

function urlHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return normalHost(u.hostname);
  } catch {
    return null;
  }
}

function isDemoHost(host: string, allowed: string): boolean {
  if ((PRODUCTION_PDS_HOSTS as readonly string[]).includes(host)) return false;
  if (allowed && host === normalHost(allowed)) return true;
  return host.includes('demo');
}

/** `dir` is `other` or one of its parents. */
function containsOrIs(dir: string, other: string): boolean {
  const target = resolve(other);
  return target === dir || target.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Why a reset must not run here; empty when every guard passes. */
export function demoGuardProblems(g: DemoGuardInput): string[] {
  const problems: string[] = [];

  const plcHost = urlHost(g.plcDirectoryUrl);
  if (!plcHost) {
    problems.push(`PLC_DIRECTORY_URL ("${g.plcDirectoryUrl}") is not a valid http(s) URL.`);
  } else if (PRODUCTION_PLC_HOSTS.some((h) => plcHost === h || plcHost.endsWith(`.${h}`))) {
    problems.push(`PLC_DIRECTORY_URL points at a production PLC directory (${plcHost}). A demo server needs its own demo PLC directory.`);
  }

  const host = normalHost(g.pdsHostname);
  if (!isDemoHost(host, g.allowedHostname)) {
    problems.push(`PDS_HOSTNAME ("${g.pdsHostname}") does not contain "demo" and is not DEMO_ALLOWED_HOSTNAME.`);
  }
  const serviceHost = urlHost(g.pdsServiceUrl);
  if (!serviceHost || !isDemoHost(serviceHost, g.allowedHostname)) {
    problems.push(`PDS_SERVICE_URL ("${g.pdsServiceUrl}") is not a demo host: it must contain "demo" or be DEMO_ALLOWED_HOSTNAME.`);
  }

  if (g.blobStorage !== 'local') {
    problems.push(`BLOB_STORAGE is "${g.blobStorage}": a demo server stores blobs locally, so the reset deletes nothing but its own.`);
  } else {
    const dir = resolve(g.cwd, g.blobPath);
    if (parse(dir).root === dir || containsOrIs(dir, g.cwd) || (g.home && containsOrIs(dir, g.home))) {
      problems.push(`BLOB_STORAGE_PATH ("${g.blobPath}") is the filesystem root, the working directory, the home directory or a parent of one: the reset would delete more than blobs.`);
    }
  }
  return problems;
}

/**
 * Why the server must not start: a DEMO_MODE or schedule it cannot read, or,
 * with DEMO_MODE=true, a failing guard. Empty without demo mode.
 */
export function demoStartupProblems(env: Env = process.env, guard?: DemoGuardInput): string[] {
  let cfg: DemoConfig;
  try {
    cfg = readDemoConfig(env);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  if (!cfg.enabled) return [];
  return demoGuardProblems(guard ?? currentDemoGuardInput(env));
}

// ── Refusing requests while resetting ────────────────────────────

let resetting = false;

export function isDemoResetting(): boolean {
  return resetting;
}

/** Tests only. */
export function setDemoResettingForTests(value: boolean): void {
  resetting = value;
}

/** 503 DemoResetting for every request while the reset runs. */
export function demoResetGate(_req: Request, res: Response, next: NextFunction): void {
  if (!resetting) { next(); return; }
  res.setHeader('Retry-After', '120');
  res.status(503).json({
    error: 'DemoResetting',
    message: 'This demo server is deleting everything for its nightly fresh start. Try again in a couple of minutes.',
  });
}

// ── The public flag ──────────────────────────────────────────────

export type DemoPublicInfo = { enabled: false } | { enabled: true; resetSchedule: string; nextResetAt: string };

/** For getPublicConfig: whether this is a demo server and when it is next wiped. */
export function demoPublicInfo(env: Env = process.env, now: Date = new Date()): DemoPublicInfo {
  try {
    const cfg = readDemoConfig(env);
    if (!cfg.enabled || !cfg.cron) return { enabled: false };
    return { enabled: true, resetSchedule: cfg.resetSchedule, nextResetAt: nextCronRun(cfg.cron, now).toISOString() };
  } catch {
    return { enabled: false };
  }
}

// ── The reset ────────────────────────────────────────────────────

/**
 * reset: wiped and serving again. refused: a guard failed, nothing touched.
 * failed: the wipe failed, nothing deleted, still serving. exited: wiped, but
 * the fresh start failed, so the process exits (DEMO_RESET_EXIT_CODE).
 */
export type DemoResetOutcome = 'reset' | 'refused' | 'failed' | 'exited';

export interface DemoResetOptions {
  env?: Env;
  /** Defaults to this server's configuration (currentDemoGuardInput). */
  guard?: DemoGuardInput;
  /** Defaults to process.exit; only called when the fresh start fails. */
  exit?: (code: number) => void;
  /** The start-up seeding run after the wipe. Defaults to seedStartupData (tests inject a failure). */
  seed?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  drainMs?: number;
  /** Tests: called at each step. */
  onPhase?: (phase: 'draining' | 'database' | 'blobs' | 'caches' | 'seeding') => void;
}

async function truncateApplicationTables(): Promise<number> {
  const tables = (await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
     ORDER BY tablename`,
  )).rows.map((r) => r.tablename);
  if (tables.length === 0) return 0;
  const list = tables.map((t) => `public."${t.replace(/"/g, '""')}"`).join(', ');
  await query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  return tables.length;
}

/** Everything inside the blob directory; the directory itself stays (it may be a mounted volume). */
async function deleteLocalBlobs(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const entries = await readdir(dir);
  for (const entry of entries) await rm(join(dir, entry), { recursive: true, force: true });
  return entries.length;
}

/**
 * Wipe this demo server and bring it back to a fresh start in-process,
 * exiting only when that fails. Refuses, touching nothing, unless
 * DEMO_MODE=true and every guard passes.
 */
export async function runDemoReset(opts: DemoResetOptions = {}): Promise<DemoResetOutcome> {
  const env = opts.env ?? process.env;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let cfg: DemoConfig;
  try {
    cfg = readDemoConfig(env);
  } catch (err) {
    console.error(`Demo reset refused: ${err instanceof Error ? err.message : String(err)}`);
    return 'refused';
  }
  if (!cfg.enabled) {
    console.error('Demo reset refused: DEMO_MODE is not true.');
    return 'refused';
  }
  const guard = opts.guard ?? currentDemoGuardInput(env);
  const problems = demoGuardProblems(guard);
  if (problems.length > 0) {
    console.error(`Demo reset refused: ${problems.join(' ')}`);
    return 'refused';
  }

  resetting = true;
  opts.onPhase?.('draining');
  await sleep(opts.drainMs ?? DRAIN_MS);

  let tables: number;
  try {
    opts.onPhase?.('database');
    tables = await truncateApplicationTables();
  } catch (err) {
    // Nothing was emptied (TRUNCATE is one statement): keep serving, and try
    // again at the next scheduled time.
    resetting = false;
    console.error('Demo reset failed; nothing was deleted:', err instanceof Error ? err.message : err);
    return 'failed';
  }

  let blobs = 0;
  try {
    opts.onPhase?.('blobs');
    blobs = await deleteLocalBlobs(resolve(guard.cwd, guard.blobPath));
  } catch (err) {
    // The database no longer refers to them; they are unreachable either way.
    console.error('Demo reset: could not delete every blob:', err instanceof Error ? err.message : err);
  }

  try {
    opts.onPhase?.('caches');
    await clearInMemoryState();
    opts.onPhase?.('seeding');
    await (opts.seed ?? seedStartupData)();
  } catch (err) {
    // The data is gone but this process is not back to a fresh start. Keep
    // refusing requests and let the platform start it again: the last resort.
    clearKeypairCache();
    console.error('Demo reset: the fresh start after the wipe failed:', err instanceof Error ? err.message : err);
    console.log(`Demo reset: emptied ${tables} tables and ${blobs} blob entries; exiting with code ${DEMO_RESET_EXIT_CODE} for the platform to start the server again.`);
    exit(DEMO_RESET_EXIT_CODE);
    return 'exited';
  }

  resetting = false;
  console.log(`Demo reset: emptied ${tables} tables and ${blobs} blob entries, cleared the caches and ran the start-up seeding; serving again.`);
  return 'reset';
}

// ── The timer ────────────────────────────────────────────────────

let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every start and stop, so a reset finishing after a stop does not re-arm. */
let generation = 0;

/**
 * Run the reset at each scheduled time. Returns false, starting nothing,
 * without demo mode. A single timer never waits longer than an hour, so a
 * schedule weeks away is fine.
 */
export function startDemoResetScheduler(opts: { env?: Env; reset?: () => Promise<unknown> } = {}): boolean {
  const env = opts.env ?? process.env;
  const cfg = readDemoConfig(env);
  if (!cfg.enabled || !cfg.cron) return false;
  const cron = cfg.cron;
  const reset = opts.reset ?? (() => runDemoReset({ env }));
  stopDemoResetScheduler();
  const mine = ++generation;

  const arm = () => {
    if (mine !== generation) return;
    const target = nextCronRun(cron, new Date()).getTime();
    const wait = () => {
      const ms = target - Date.now();
      if (ms <= 0) {
        timer = null;
        Promise.resolve()
          .then(reset)
          .catch((err) => console.error('Demo reset failed:', err))
          .finally(arm);
        return;
      }
      timer = setTimeout(wait, Math.min(ms, MAX_TIMER_MS));
      timer.unref?.();
    };
    wait();
  };
  arm();
  console.log(`Demo mode: everything on this server is deleted on the schedule "${cfg.resetSchedule}" (UTC); next at ${nextCronRun(cron, new Date()).toISOString()}.`);
  return true;
}

export function stopDemoResetScheduler(): void {
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
}
