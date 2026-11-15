/**
 * Demo mode for the PLC directory (docs/DEMO-SERVERS.md).
 *
 * A demo PDS registers every identity it creates in its own demo PLC
 * directory, and visitors' Self accounts and pen names hold their own
 * rotation keys there. So the directory is wiped with the PDSes: with
 * DEMO_MODE=true, at DEMO_RESET_SCHEDULE (cron, UTC; default 03:00 daily) it
 * answers 503 DemoResetting, empties its tables (all but the migration
 * ledger) and exits with code 75, for the platform to start it again
 * (restart policy ON_FAILURE or ALWAYS).
 *
 * Guards, checked at start-up (the directory refuses to start) and again
 * right before the wipe: PLC_PUBLIC_URL, this directory's own public URL,
 * is set; its host contains "demo" or equals DEMO_ALLOWED_HOSTNAME; and it is
 * not a production directory (plc.openfederation.net, plc.directory).
 *
 * Without DEMO_MODE nothing here runs. The cron rules are the same as
 * src/demo/cron.ts (this service is deployed on its own and cannot import it).
 */
'use strict';

const DEFAULT_SCHEDULE = '0 3 * * *';
const EXIT_CODE = 75;
const PRODUCTION_PLC_HOSTS = ['plc.openfederation.net', 'plc.directory'];
/** The library's migration ledger (Kysely): kept, so the schema is not rebuilt. */
const KEEP_TABLES = ['kysely_migration', 'kysely_migration_lock'];
const DRAIN_MS = 5000;
const MAX_TIMER_MS = 60 * 60 * 1000;

// ── Cron (five fields, UTC) ──────────────────────────────────────

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function parseField(raw, min, max, name) {
  const out = new Set();
  const num = (s) => {
    if (!/^\d+$/.test(s)) throw new Error(`"${s}" is not a number in the ${name} field`);
    const n = parseInt(s, 10);
    if (n < min || n > max) throw new Error(`${n} is outside ${min}-${max} in the ${name} field`);
    return n;
  };
  for (const part of raw.split(',')) {
    const [range, stepRaw, extra] = part.split('/');
    if (extra !== undefined || range === '') throw new Error(`"${part}" is not valid in the ${name} field`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || parseInt(stepRaw, 10) < 1) throw new Error(`"${part}" has an invalid step in the ${name} field`);
      step = parseInt(stepRaw, 10);
    }
    let lo;
    let hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined) throw new Error(`"${part}" is not valid in the ${name} field`);
      lo = num(a); hi = num(b);
      if (lo > hi) throw new Error(`"${part}" runs backwards in the ${name} field`);
    } else {
      lo = num(range);
      hi = stepRaw !== undefined ? max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error(`a cron expression has five fields, got "${expr}"`);
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parts.map((p, i) => parseField(p, FIELDS[i].min, FIELDS[i].max, FIELDS[i].name));
  if (daysOfWeek.has(7)) { daysOfWeek.delete(7); daysOfWeek.add(0); }
  return { minutes, hours, daysOfMonth, months, daysOfWeek, domRestricted: parts[2] !== '*', dowRestricted: parts[4] !== '*' };
}

function dayMatches(s, d) {
  const dom = s.daysOfMonth.has(d.getUTCDate());
  const dow = s.daysOfWeek.has(d.getUTCDay());
  if (s.domRestricted && s.dowRestricted) return dom || dow;
  if (s.domRestricted) return dom;
  if (s.dowRestricted) return dow;
  return true;
}

function nextCronRun(s, after) {
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86400000;
  while (t.getTime() <= limit) {
    if (!s.months.has(t.getUTCMonth() + 1) || !dayMatches(s, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hours.has(t.getUTCHours())) { t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0); continue; }
    if (!s.minutes.has(t.getUTCMinutes())) { t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0); continue; }
    return t;
  }
  throw new Error('the cron expression never matches');
}

// ── Configuration and guards ─────────────────────────────────────

/** DEMO_MODE and DEMO_RESET_SCHEDULE; throws on a value it cannot read. */
function readDemoConfig(env) {
  const raw = (env.DEMO_MODE || '').trim().toLowerCase();
  if (raw !== '' && raw !== 'true' && raw !== 'false') throw new Error(`DEMO_MODE must be "true" or "false" (got "${env.DEMO_MODE}").`);
  const resetSchedule = (env.DEMO_RESET_SCHEDULE || '').trim() || DEFAULT_SCHEDULE;
  if (raw !== 'true') return { enabled: false, resetSchedule, cron: null };
  let cron;
  try {
    cron = parseCron(resetSchedule);
    nextCronRun(cron, new Date());
  } catch (err) {
    throw new Error(`DEMO_RESET_SCHEDULE: ${err.message}.`);
  }
  return { enabled: true, resetSchedule, cron };
}

const normalHost = (h) => h.trim().toLowerCase().replace(/\.+$/, '');

/** Why this directory must not be reset as a demo; empty when every guard passes. */
function demoGuardProblems(env) {
  const problems = [];
  const publicUrl = (env.PLC_PUBLIC_URL || '').trim();
  let host = null;
  try {
    const u = new URL(publicUrl);
    if (u.protocol === 'http:' || u.protocol === 'https:') host = normalHost(u.hostname);
  } catch { /* reported below */ }
  if (!host) {
    problems.push(`PLC_PUBLIC_URL ("${publicUrl}") must be this directory's public http(s) URL.`);
    return problems;
  }
  if (PRODUCTION_PLC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    problems.push(`PLC_PUBLIC_URL is a production PLC directory (${host}); it is never reset.`);
    return problems;
  }
  const allowed = normalHost(env.DEMO_ALLOWED_HOSTNAME || '');
  if (!host.includes('demo') && !(allowed && host === allowed)) {
    problems.push(`PLC_PUBLIC_URL's host (${host}) does not contain "demo" and is not DEMO_ALLOWED_HOSTNAME.`);
  }
  return problems;
}

/** For start-up: a bad DEMO_MODE or schedule, or with DEMO_MODE=true a failing guard. */
function demoStartupProblems(env) {
  let cfg;
  try { cfg = readDemoConfig(env); } catch (err) { return [err.message]; }
  if (!cfg.enabled) return [];
  return demoGuardProblems(env);
}

// ── Refusing requests while resetting ────────────────────────────

let resetting = false;
const isResetting = () => resetting;
function setResettingForTests(value) { resetting = value; }

function resetGate(req, res, next) {
  if (!resetting) return next();
  res.setHeader('Retry-After', '120');
  res.status(503).json({ error: 'DemoResetting', message: 'This demo PLC directory is deleting everything for its nightly fresh start. Try again in a couple of minutes.' });
}

// ── The reset ────────────────────────────────────────────────────

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** Empty every table in `schema` but the migration ledger. Returns how many. */
async function truncatePlcTables(pool, schema = 'public') {
  const res = await pool.query(
    'SELECT tablename FROM pg_tables WHERE schemaname = $1 AND NOT (tablename = ANY($2)) ORDER BY tablename',
    [schema, KEEP_TABLES],
  );
  const tables = res.rows.map((r) => r.tablename);
  if (tables.length === 0) return 0;
  await pool.query(`TRUNCATE TABLE ${tables.map((t) => `${quoteIdent(schema)}.${quoteIdent(t)}`).join(', ')} RESTART IDENTITY CASCADE`);
  return tables.length;
}

/**
 * Wipe this demo directory and exit. Refuses, touching nothing, unless
 * DEMO_MODE=true and every guard passes. `getPool` returns a pg Pool, or
 * null when the directory runs in memory (the exit is then the wipe).
 */
async function runDemoReset(opts) {
  const env = opts.env || process.env;
  const exit = opts.exit || ((code) => process.exit(code));
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let cfg;
  try { cfg = readDemoConfig(env); } catch (err) {
    console.error(`Demo reset refused: ${err.message}`);
    return 'refused';
  }
  if (!cfg.enabled) { console.error('Demo reset refused: DEMO_MODE is not true.'); return 'refused'; }
  const problems = demoGuardProblems(env);
  if (problems.length > 0) { console.error(`Demo reset refused: ${problems.join(' ')}`); return 'refused'; }

  resetting = true;
  await sleep(opts.drainMs === undefined ? DRAIN_MS : opts.drainMs);
  let tables = 0;
  const pool = opts.getPool ? await opts.getPool() : null;
  if (pool) {
    try {
      tables = await truncatePlcTables(pool, opts.schema || 'public');
    } catch (err) {
      resetting = false;
      console.error('Demo reset failed; nothing was deleted:', err.message);
      if (opts.endPoolOnFailure && pool.end) await pool.end().catch(() => {});
      return 'failed';
    }
  }
  console.log(`Demo reset: emptied ${tables} PLC tables; exiting with code ${EXIT_CODE} for a fresh start.`);
  exit(EXIT_CODE);
  return 'reset';
}

// ── The timer ────────────────────────────────────────────────────

let timer = null;
let generation = 0;

/** Run `reset` at each scheduled time; false, starting nothing, without demo mode. */
function startDemoResetScheduler(opts) {
  const env = opts.env || process.env;
  const cfg = readDemoConfig(env);
  if (!cfg.enabled) return false;
  stopDemoResetScheduler();
  const mine = ++generation;
  const arm = () => {
    if (mine !== generation) return;
    const target = nextCronRun(cfg.cron, new Date()).getTime();
    const wait = () => {
      const ms = target - Date.now();
      if (ms <= 0) {
        timer = null;
        Promise.resolve().then(opts.reset).catch((err) => console.error('Demo reset failed:', err)).finally(arm);
        return;
      }
      timer = setTimeout(wait, Math.min(ms, MAX_TIMER_MS));
      if (timer.unref) timer.unref();
    };
    wait();
  };
  arm();
  console.log(`Demo mode: this PLC directory is wiped on the schedule "${cfg.resetSchedule}" (UTC); next at ${nextCronRun(cfg.cron, new Date()).toISOString()}.`);
  return true;
}

function stopDemoResetScheduler() {
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  DEFAULT_SCHEDULE, EXIT_CODE, PRODUCTION_PLC_HOSTS, KEEP_TABLES,
  parseCron, nextCronRun, readDemoConfig, demoGuardProblems, demoStartupProblems,
  resetGate, isResetting, setResettingForTests, truncatePlcTables, runDemoReset,
  startDemoResetScheduler, stopDemoResetScheduler,
};
