/**
 * Stage demo launcher: `npm run demo`.
 *
 * Runs a private, offline stack on this laptop and serves the Open Newsrooms
 * stage app:
 *   - PLC directory, in memory (port 2683), so every reset starts empty
 *   - PDS on its own database, openfederation_pds_demo (port 8091)
 *   - the stage app and its small helper API (port 4747)
 *
 * The helper API only seeds Elena's account, reads the PDS database for the
 * "what the server knows" screen and runs the independent verifier. Pseudonym
 * keys are made and used in the browser; the phrase never reaches this process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as dotenv from 'dotenv';
import express from 'express';
import * as esbuild from 'esbuild';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
dotenv.config({ path: join(ROOT, '.env'), quiet: true });

const PORTS = {
  plc: Number(process.env.DEMO_PLC_PORT || 2683),
  pds: Number(process.env.DEMO_PDS_PORT || 8091),
  app: Number(process.env.DEMO_APP_PORT || 4747),
};
const DEMO_DB = process.env.DEMO_DB_NAME || 'openfederation_pds_demo';
const PLC_URL = `http://localhost:${PORTS.plc}`;
const PDS_URL = `http://localhost:${PORTS.pds}`;
const SERVICE_DID = 'did:web:localhost';
const HANDLE_SUFFIX = '.opennewsrooms.demo';
const ELENA = { handle: `elena${HANDLE_SUFFIX}`, name: 'Elena Petrova', email: 'elena@newsroom.demo' };

const db = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
};

const LOG_DIR = join(HERE, '.logs');
mkdirSync(LOG_DIR, { recursive: true });

// ---------- Stack ----------

let plc: ChildProcess | null = null;
let pds: ChildProcess | null = null;
let admin = { handle: 'admin', email: 'admin@newsroom.demo', password: '' };
let elena: { did: string; password: string } | null = null;
let pseudonymDids = new Set<string>();

function strongPassword(): string {
  return `Demo-${crypto.randomBytes(9).toString('base64url')}-7a!`;
}

function start(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const log = createWriteStream(join(LOG_DIR, `${name}.log`), { flags: 'w' });
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return child;
}

function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 4000);
  });
}

async function waitFor(url: string, what: string, timeoutMs = 60000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${what} did not start; see demo/stage/.logs/`);
}

async function freshDatabase(): Promise<void> {
  const server = new pg.Client({ ...db, database: 'postgres' });
  await server.connect();
  try {
    await server.query(`DROP DATABASE IF EXISTS ${DEMO_DB} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${DEMO_DB}`);
  } finally {
    await server.end();
  }
  const client = new pg.Client({ ...db, database: DEMO_DB });
  await client.connect();
  try {
    await client.query('SET client_min_messages TO warning');
    await client.query(readFileSync(join(ROOT, 'src/db/schema.sql'), 'utf8'));
    const migrations = readdirSync(join(ROOT, 'scripts'))
      .filter((f) => /^migrate-\d+.*\.sql$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    for (const f of migrations) await client.query(readFileSync(join(ROOT, 'scripts', f), 'utf8'));
  } finally {
    await client.end();
  }
}

async function xrpc<T = any>(nsid: string, body?: unknown, jwt?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${PDS_URL}/xrpc/${nsid}`, body === undefined
    ? { headers }
    : { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${nsid} failed (${res.status}): ${JSON.stringify(json)}`);
  return json as T;
}

async function session(identifier: string, password: string): Promise<{ accessJwt: string; did: string; handle: string }> {
  return xrpc('com.atproto.server.createSession', { identifier, password });
}

async function seedElena(): Promise<void> {
  const adminJwt = (await session(admin.handle, admin.password)).accessJwt;
  const invite = await xrpc<{ code: string }>('net.openfederation.invite.create', { maxUses: 1 }, adminJwt);
  const password = strongPassword();
  const reg = await xrpc<{ userId?: string; id?: string; did: string }>('net.openfederation.account.register', {
    handle: ELENA.handle.slice(0, -HANDLE_SUFFIX.length), email: ELENA.email, password, inviteCode: invite.code,
  });
  await xrpc('net.openfederation.account.approve', { userId: reg.userId || reg.id }, adminJwt);
  const s = await session(ELENA.email, password);
  elena = { did: s.did, password };
}

let state: 'starting' | 'ready' | 'resetting' | 'failed' = 'starting';
let lastError = '';

async function bringUp(): Promise<void> {
  state = state === 'starting' ? 'starting' : 'resetting';
  elena = null;
  pseudonymDids = new Set();
  try {
    await Promise.all([stop(pds), stop(plc)]);
    await freshDatabase();
    admin = { ...admin, password: strongPassword() };
    plc = start('plc', ['node_modules/@did-plc/server/dist/bin.js'], { ...process.env, PORT: String(PORTS.plc), DATABASE_URL: '' });
    await waitFor(`${PLC_URL}/_health`, 'PLC directory');
    pds = start('pds', ['--import', './scripts/register-ts-node.mjs', 'src/index.ts'], {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORTS.pds),
      DB_NAME: DEMO_DB,
      PDS_HOSTNAME: 'localhost',
      PDS_SERVICE_URL: PDS_URL,
      PDS_SERVICE_DID: SERVICE_DID,
      PLC_DIRECTORY_URL: PLC_URL,
      HANDLE_SUFFIX,
      BOOTSTRAP_ADMIN_EMAIL: admin.email,
      BOOTSTRAP_ADMIN_HANDLE: admin.handle,
      BOOTSTRAP_ADMIN_PASSWORD: admin.password,
      GLOBAL_RATE_LIMIT: '100000',
      CREATE_RATE_LIMIT: '10000',
      PSEUDONYM_PROBATION_DAYS: '7',
    });
    await waitFor(`${PDS_URL}/health`, 'PDS', 120000);
    await seedElena();
    state = 'ready';
    lastError = '';
    console.log(`Ready. Open http://localhost:${PORTS.app}`);
  } catch (err) {
    state = 'failed';
    lastError = err instanceof Error ? err.message : String(err);
    console.error('Demo stack failed:', lastError);
  }
}

// ---------- What the server knows ----------

async function serverView(pseudonymDid: string | undefined) {
  if (!elena) throw new Error('Not seeded');
  const client = new pg.Client({ ...db, database: DEMO_DB });
  await client.connect();
  try {
    const dids = [elena.did, ...(pseudonymDid ? [pseudonymDid] : [])];
    const users = await client.query(
      `SELECT id, handle, did, email, auth_type, status, password_hash IS NOT NULL AS has_password,
              pseudonym_owner_key, created_at, approved_at
         FROM users WHERE did = ANY($1)`, [dids]);
    const rows = await Promise.all(users.rows.map(async (u) => {
      const audit = await client.query(
        'SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 OR target_id = $1 OR target_id = $2', [u.id, u.did]);
      return {
        did: u.did, handle: u.handle, email: u.email, kind: u.auth_type, status: u.status,
        hasPassword: u.has_password, loginKey: u.pseudonym_owner_key,
        createdAt: u.created_at, approvedAt: u.approved_at, auditEntries: audit.rows[0].n,
      };
    }));

    // Search every table, row by row, for anything naming both accounts.
    let tables = 0;
    let bothRows = 0;
    if (pseudonymDid) {
      const list = await client.query(
        `SELECT quote_ident(table_name) AS t FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
      tables = list.rows.length;
      for (const { t } of list.rows) {
        const r = await client.query(
          `SELECT count(*)::int AS n FROM ${t} x WHERE x::text LIKE $1 AND x::text LIKE $2`,
          [`%${elena.did}%`, `%${pseudonymDid}%`]);
        bothRows += r.rows[0].n;
      }
    }
    const batches = await client.query('SELECT count(*)::int AS n FROM pseudonym_token_batches');
    const spent = await client.query('SELECT count(*)::int AS n FROM pseudonym_tokens_spent');
    return { accounts: rows, search: { tables, bothRows }, tokens: { batchesCollected: batches.rows[0].n, spent: spent.rows[0].n } };
  } finally {
    await client.end();
  }
}

// ---------- App server ----------

/** The audience's word becomes the 64-hex challenge. The device derives it the same way (app/main.ts). */
function challengeForWord(word: string): string {
  return crypto.createHash('sha256').update(`OpenNewsrooms stage challenge\n${word.trim().toLowerCase()}`).digest('hex');
}

async function bundle(): Promise<void> {
  const ctx = await esbuild.context({
    entryPoints: [join(HERE, 'app', 'main.ts')],
    outfile: join(HERE, 'public', 'app.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    sourcemap: true, logLevel: 'warning',
  });
  await ctx.rebuild();
  // Rebuild on save while rehearsing; harmless on stage.
  await ctx.watch();
}

async function main(): Promise<void> {
  await bundle();
  const { verifyPresence, fetchGenesisOp } = await import('../../src/identity/pseudonym/verify.js');

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(join(HERE, 'public'), { extensions: ['html'] }));

  app.get('/api/status', (_req, res) => {
    res.json({ state, error: lastError });
  });

  app.get('/api/state', async (_req, res) => {
    if (state !== 'ready' || !elena) return res.status(503).json({ state, error: lastError });
    try {
      const s = await session(ELENA.email, elena.password);
      res.json({
        pdsUrl: PDS_URL, plcUrl: PLC_URL, serviceDid: SERVICE_DID, handleSuffix: HANDLE_SUFFIX,
        elena: { did: s.did, handle: s.handle, name: ELENA.name, email: ELENA.email, accessJwt: s.accessJwt },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/server-view', async (req, res) => {
    try {
      const did = typeof req.query.pseudonym === 'string' && req.query.pseudonym.startsWith('did:plc:') ? req.query.pseudonym : undefined;
      if (did) pseudonymDids.add(did);
      res.json(await serverView(did));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The independent verifier: it knows only the pseudonym's DID, the word the
  // audience called out and the signature. It takes the public key from the
  // PLC directory, never from the device being checked.
  app.post('/api/verify-presence', async (req, res) => {
    const { pseudonymDid, word, signature } = req.body ?? {};
    if (typeof pseudonymDid !== 'string' || typeof word !== 'string' || !word.trim() || typeof signature !== 'string') {
      return res.status(400).json({ error: 'pseudonymDid, word and signature are required' });
    }
    try {
      const challenge = challengeForWord(word);
      const genesisOp = await fetchGenesisOp(pseudonymDid, { plcUrl: PLC_URL });
      if (!genesisOp) return res.json({ valid: false, error: 'Not found in the directory', challenge });
      const valid = await verifyPresence({ pseudonymDid, genesisOp, challenge, signature });
      res.json({ valid, challenge, directoryKey: (genesisOp as { rotationKeys?: string[] }).rotationKeys?.[0] });
    } catch (err) {
      res.json({ valid: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/reset', (_req, res) => {
    if (state === 'resetting' || state === 'starting') return res.json({ state });
    state = 'resetting';
    void bringUp();
    res.json({ state });
  });

  app.listen(PORTS.app, '127.0.0.1', () => {
    console.log(`Stage app: http://localhost:${PORTS.app} (starting the stack…)`);
  });
  await bringUp();
}

async function shutdown(): Promise<void> {
  await Promise.all([stop(pds), stop(plc)]);
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

main().catch((err) => {
  console.error(err);
  void shutdown();
});
