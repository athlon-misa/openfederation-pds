/**
 * Stage demo launcher: `npm run demo`.
 *
 * Runs a private, offline stack on this laptop and serves the Open Newsrooms
 * stage app:
 *   - PLC directory, in memory (port 2683), so every reset starts empty
 *   - PDS on its own database, openfederation_pds_demo (port 8091)
 *   - a second PDS, "the new home" Night Desk can move to (port 8092)
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
  pdsB: Number(process.env.DEMO_PDS_B_PORT || 8092),
  app: Number(process.env.DEMO_APP_PORT || 4747),
};
const DEMO_DB = process.env.DEMO_DB_NAME || 'openfederation_pds_demo';
const DEMO_DB_B = `${DEMO_DB}_b`;
const PLC_URL = `http://localhost:${PORTS.plc}`;
const PDS_URL = `http://localhost:${PORTS.pds}`;
const PDS_B_URL = `http://localhost:${PORTS.pdsB}`;
const SERVICE_DID = 'did:web:localhost';
const HANDLE_SUFFIX = '.opennewsrooms.demo';
const ELENA = { handle: `elena${HANDLE_SUFFIX}`, name: 'Elena Petrova', email: 'elena@newsroom.demo' };
const MARKO = { handle: 'marko', name: 'Marko', email: 'marko@newsroom.demo' };

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
let pdsB: ChildProcess | null = null;
let admin = { handle: 'admin', email: 'admin@newsroom.demo', password: '' };
let adminB = { ...admin };
let elena: { did: string; password: string } | null = null;
let marko: { did: string } | null = null;
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
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
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

async function freshDatabase(name: string): Promise<void> {
  const server = new pg.Client({ ...db, database: 'postgres' });
  await server.connect();
  try {
    await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${name}`);
  } finally {
    await server.end();
  }
  const client = new pg.Client({ ...db, database: name });
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

async function xrpc<T = any>(nsid: string, body?: unknown, jwt?: string, base = PDS_URL): Promise<T> {
  const headers: Record<string, string> = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}/xrpc/${nsid}`, body === undefined
    ? { headers }
    : { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${nsid} failed (${res.status}): ${JSON.stringify(json)}`);
  return json as T;
}

async function session(identifier: string, password: string, base = PDS_URL): Promise<{ accessJwt: string; did: string; handle: string }> {
  return xrpc('com.atproto.server.createSession', { identifier, password }, undefined, base);
}

function startPds(name: string, port: number, database: string, serviceDid: string, who: typeof admin): ChildProcess {
  return start(name, ['--import', './scripts/register-ts-node.mjs', 'src/index.ts'], {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    DB_NAME: database,
    PDS_HOSTNAME: 'localhost',
    PDS_SERVICE_URL: `http://localhost:${port}`,
    PDS_SERVICE_DID: serviceDid,
    PLC_DIRECTORY_URL: PLC_URL,
    HANDLE_SUFFIX,
    BOOTSTRAP_ADMIN_EMAIL: who.email,
    BOOTSTRAP_ADMIN_HANDLE: who.handle,
    BOOTSTRAP_ADMIN_PASSWORD: who.password,
    GLOBAL_RATE_LIMIT: '100000',
    CREATE_RATE_LIMIT: '10000',
    PSEUDONYM_PROBATION_DAYS: '7',
  });
}

async function seedAccount(adminJwt: string, handle: string, email: string): Promise<{ did: string; password: string }> {
  const invite = await xrpc<{ code: string }>('net.openfederation.invite.create', { maxUses: 1 }, adminJwt);
  const password = strongPassword();
  const reg = await xrpc<{ userId?: string; id?: string }>('net.openfederation.account.register', {
    handle, email, password, inviteCode: invite.code,
  });
  await xrpc('net.openfederation.account.approve', { userId: reg.userId || reg.id }, adminJwt);
  const s = await session(email, password);
  return { did: s.did, password };
}

/** Elena, the reporter, and Marko, who later tries to claim Night Desk as his. */
async function seedPeople(): Promise<void> {
  const adminJwt = (await session(admin.handle, admin.password)).accessJwt;
  elena = await seedAccount(adminJwt, ELENA.handle.slice(0, -HANDLE_SUFFIX.length), ELENA.email);
  marko = { did: (await seedAccount(adminJwt, MARKO.handle, MARKO.email)).did };
}

let state: 'starting' | 'ready' | 'resetting' | 'failed' = 'starting';
let lastError = '';

async function bringUp(): Promise<void> {
  state = state === 'starting' ? 'starting' : 'resetting';
  elena = null;
  marko = null;
  pseudonymDids = new Set();
  try {
    await Promise.all([stop(pds), stop(pdsB), stop(plc)]);
    await Promise.all([freshDatabase(DEMO_DB), freshDatabase(DEMO_DB_B)]);
    admin = { ...admin, password: strongPassword() };
    adminB = { ...admin, password: strongPassword() };
    plc = start('plc', ['node_modules/@did-plc/server/dist/bin.js'], { ...process.env, PORT: String(PORTS.plc), DATABASE_URL: '' });
    await waitFor(`${PLC_URL}/_health`, 'PLC directory');
    pds = startPds('pds', PORTS.pds, DEMO_DB, SERVICE_DID, admin);
    pdsB = startPds('pds-b', PORTS.pdsB, DEMO_DB_B, `did:web:localhost%3A${PORTS.pdsB}`, adminB);
    await Promise.all([waitFor(`${PDS_URL}/health`, 'PDS', 120000), waitFor(`${PDS_B_URL}/health`, 'Second PDS', 120000)]);
    await seedPeople();
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
  const { verifyPresence, fetchGenesisOp, verifyRevealBundle } = await import('../../src/identity/pseudonym/verify.js');

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
      const client = new pg.Client({ ...db, database: DEMO_DB });
      await client.connect();
      let used: { passesCollected: boolean; pseudonymExists: boolean };
      try {
        const b = await client.query('SELECT count(*)::int AS n FROM pseudonym_token_batches');
        const p = await client.query("SELECT count(*)::int AS n FROM users WHERE auth_type = 'pseudonym'");
        used = { passesCollected: b.rows[0].n > 0, pseudonymExists: p.rows[0].n > 0 };
      } finally {
        await client.end();
      }
      res.json({
        used,
        pdsUrl: PDS_URL, pdsBUrl: PDS_B_URL, plcUrl: PLC_URL, serviceDid: SERVICE_DID, handleSuffix: HANDLE_SUFFIX,
        elena: { did: s.did, handle: s.handle, name: ELENA.name, email: ELENA.email, accessJwt: s.accessJwt },
        impostor: { did: marko!.did, name: MARKO.name },
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

  // Checks a reveal the way `ofc pseudonym verify --online` does: the bundle,
  // plus both DIDs resolved from the PLC directory.
  app.post('/api/verify-reveal', async (req, res) => {
    try {
      res.json(await verifyRevealBundle(req.body?.bundle, { online: true, plcUrl: PLC_URL }));
    } catch (err) {
      res.json({ valid: false, checks: [], error: err instanceof Error ? err.message : String(err) });
    }
  });

  // "The new home" accepts Night Desk's backup. Loading a repository is an
  // operator step on that server, so the demo server does it as its admin.
  app.post('/api/server-b/import', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
    const did = typeof req.query.did === 'string' ? req.query.did : '';
    if (!did.startsWith('did:plc:') || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'did and a CAR body are required' });
    }
    try {
      const { accessJwt } = await session(adminB.handle, adminB.password, PDS_B_URL);
      const r = await fetch(`${PDS_B_URL}/xrpc/net.openfederation.admin.importRepo?did=${encodeURIComponent(did)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessJwt}`, 'Content-Type': 'application/vnd.ipld.car' }, body: new Uint8Array(req.body),
      });
      const json = await r.json().catch(() => ({}));
      res.status(r.ok ? 200 : r.status).json(json);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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
  await Promise.all([stop(pds), stop(pdsB), stop(plc)]);
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

main().catch((err) => {
  console.error(err);
  void shutdown();
});
