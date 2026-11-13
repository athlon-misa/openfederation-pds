/**
 * Stage demo launcher: `npm run demo`.
 *
 * Offline (the default) runs a private stack on this laptop and serves the
 * Open Newsrooms stage app:
 *   - PLC directory, in memory (port 2683), so every reset starts empty
 *   - PDS on its own database, openfederation_pds_demo (port 8091)
 *   - a second PDS, "the new home" Night Desk can move to (port 8092)
 *   - the stage app and its small helper API (port 4747)
 *
 * Live (`npm run demo -- --live`, or DEMO_MODE=live) starts only the stage
 * app and points it at two real servers and their PLC directory (defaults:
 * pds.openfederation.net, pds.grvty.app, plc.openfederation.net). No admin or
 * database access: Elena's and Marko's accounts come from demo/stage/.live.env.
 *
 * Cleanup (`npm run demo -- --cleanup`) deletes the accounts of rehearsal
 * pseudonyms whose words were kept locally and tombstones their DIDs.
 *
 * The helper API seeds or signs in Elena, shows what the server (offline) or
 * the public record (live) knows, and runs the independent verifier.
 * Night Desk's keys are made and used in the browser; its phrase reaches this
 * process only for rehearsal pseudonyms in live mode, to be cleaned up later.
 * Elena's identity phrase (a `self` account) is kept here in memory and given
 * to the page to sign her half of the reveal; Marko's Late Shift (the
 * custodial contrast) is made and kept here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as dotenv from 'dotenv';
import express from 'express';
import * as esbuild from 'esbuild';
import pg from 'pg';
import {
  loginWithPhrase, signOwnerJwt, tombstone, fetchTokenKeys, collectTokens, createRevealBundle,
  generatePseudonymPhrase, derivePseudonymKeys, buildPseudonymGenesisOp, signGenesisOp, didForSignedOp,
  checkPresence, challengeForWord, verifyRevealBundle, type CreationToken,
} from '../../packages/openfederation-pseudonym/src/index.js';
import { currentEpoch } from '../../packages/openfederation-pseudonym/src/formats.js';
import {
  generateCustodyPhrase, deriveCustodyKeys, buildCustodyGenesisOp, signPlcOperation, didForGenesisOp, submitPlcOperation,
} from '../../packages/openfederation-sdk/src/custody/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
dotenv.config({ path: join(ROOT, '.env'), quiet: true });

// ---------- Mode and configuration ----------

const ARGS = process.argv.slice(2);
function arg(name: string): string | undefined {
  const a = ARGS.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
}
const MODE: 'offline' | 'live' | 'cleanup' = arg('cleanup') !== undefined ? 'cleanup'
  : arg('live') !== undefined || process.env.DEMO_MODE === 'live' ? 'live' : 'offline';

const PORTS = {
  plc: Number(process.env.DEMO_PLC_PORT || 2683),
  pds: Number(process.env.DEMO_PDS_PORT || 8091),
  pdsB: Number(process.env.DEMO_PDS_B_PORT || 8092),
  app: Number(process.env.DEMO_APP_PORT || 4747),
};
const DEMO_DB = process.env.DEMO_DB_NAME || 'openfederation_pds_demo';
const DEMO_DB_B = `${DEMO_DB}_b`;
const SERVICE_DID = 'did:web:localhost';
const SERVICE_DID_B = `did:web:localhost%3A${PORTS.pdsB}`;
const HANDLE_SUFFIX = '.opennewsrooms.demo';
const ELENA = { handle: `elena${HANDLE_SUFFIX}`, name: 'Elena Petrova', email: 'elena@newsroom.demo' };
const MARKO = { handle: 'marko', name: 'Marko', email: 'marko@newsroom.demo' };
/** Marko's own pseudonym, for the custodial contrast on the Reveal screen. */
const LATE_SHIFT = { label: 'lateshift', name: 'Late Shift' };
/** The audience's word becomes a challenge with this context, here, in the browser and on /verify. */
const PRESENCE_CONTEXT = 'OpenNewsrooms stage challenge';

/** Live settings: demo/stage/.live.env (git-ignored), overridden by the environment. */
const LIVE_ENV_FILE = process.env.DEMO_LIVE_ENV || join(HERE, '.live.env');
/** Elena's passes and rehearsal words, kept on this laptop (git-ignored). */
const LIVE_DIR = process.env.DEMO_LIVE_DIR || join(HERE, '.live');
const WALLETS_FILE = join(LIVE_DIR, 'wallets.json');
const REHEARSALS_FILE = join(LIVE_DIR, 'rehearsals.json');

function liveEnv(): Record<string, string> {
  const file = existsSync(LIVE_ENV_FILE) ? dotenv.parse(readFileSync(LIVE_ENV_FILE)) : {};
  const fromEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('DEMO_') && v !== undefined)) as Record<string, string>;
  return { ...file, ...fromEnv };
}
const LIVE = liveEnv();
const trimUrl = (u: string) => u.replace(/\/+$/, '');

/** 0 for the show; N to rehearse with DEMO_REHEARSAL_<N>_* and keep the words for --cleanup. */
const REHEARSAL = (() => {
  const v = arg('rehearsal') ?? LIVE.DEMO_REHEARSAL ?? '';
  if (v === '' && arg('rehearsal') !== undefined) return 1;
  if (/^(true|yes|on)$/i.test(v)) return 1;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
})();

const db = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
};

const LOG_DIR = join(HERE, '.logs');
mkdirSync(LOG_DIR, { recursive: true });

/** A PDS as the stage app sees it: where it is and what it says about itself. */
interface Server {
  url: string;
  /** Its DID: the audience of owner-key JWTs and phrase logins. */
  serviceDid: string;
  /** Its handle domain, from describeServer (e.g. ".grvty.app"). */
  handleSuffix: string;
  /** The endpoint a DID document names for it (getPublicConfig serviceUrl). */
  serviceUrl: string;
  config?: PublicConfig;
}
interface PublicConfig {
  serviceUrl?: string; plcDirectoryUrl?: string;
  migration?: { pseudonyms?: string };
  identity?: { pseudonymsEnabled?: boolean; custodyAllowed?: string[] };
}

const stack = {
  plcUrl: MODE === 'offline' ? `http://localhost:${PORTS.plc}` : trimUrl(LIVE.DEMO_PLC_URL || 'https://plc.openfederation.net'),
  a: { url: MODE === 'offline' ? `http://localhost:${PORTS.pds}` : trimUrl(LIVE.DEMO_PDS_A_URL || 'https://pds.openfederation.net') } as Server,
  b: { url: MODE === 'offline' ? `http://localhost:${PORTS.pdsB}` : trimUrl(LIVE.DEMO_PDS_B_URL || 'https://pds.grvty.app') } as Server,
};

// ---------- Small HTTP helpers ----------

async function xrpc<T = any>(nsid: string, body?: unknown, jwt?: string, base = stack.a.url): Promise<T> {
  const headers: Record<string, string> = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}/xrpc/${nsid}`, body === undefined
    ? { headers, signal: AbortSignal.timeout(15000) }
    : { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${nsid} failed (${res.status}): ${JSON.stringify(json)}`);
  return json as T;
}

/** A did:plc as PLC issues it, so a DID from a request can't reshape a URL. */
const PLC_DID = /^did:plc:[a-z2-7]{24}$/;
function isPlcDid(value: unknown): value is string {
  return typeof value === 'string' && PLC_DID.test(value);
}

async function getJson<T = any>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json() as Promise<T>;
}

async function session(identifier: string, password: string, base = stack.a.url): Promise<{ accessJwt: string; did: string; handle: string }> {
  return xrpc('com.atproto.server.createSession', { identifier, password }, undefined, base);
}

/** Service DID, handle domain and public config, all read from the server itself. */
async function describe(server: Server): Promise<void> {
  const d = await xrpc<{ did: string; availableUserDomains?: string[] }>('com.atproto.server.describeServer', undefined, undefined, server.url);
  const suffix = d.availableUserDomains?.[0];
  if (!d.did || !suffix) throw new Error(`${server.url} did not describe itself`);
  server.serviceDid = d.did;
  server.handleSuffix = suffix.startsWith('.') ? suffix : `.${suffix}`;
  server.config = await xrpc<PublicConfig>('net.openfederation.server.getPublicConfig', undefined, undefined, server.url).catch(() => undefined);
  server.serviceUrl = trimUrl(server.config?.serviceUrl || server.url);
}

const host = (url: string) => url.replace(/^https?:\/\//, '');

// ---------- People ----------

type Custody = 'custodial' | 'assisted' | 'self';
interface Person {
  did: string; login: string; password: string; handle?: string;
  /** custodial: her server signs her half of a reveal. assisted/self: her own owner key does. */
  custody: Custody;
  /** assisted/self: her identity phrase, kept in memory for the session; the browser signs with it. Never logged. */
  phrase?: string;
}
let elena: Person | null = null;
/** Marko: his DID always; his sign-in only when the custodial contrast can run. */
let marko: { did: string; login?: string; password?: string } | null = null;
let elenaCache: { accessJwt: string; did: string; handle: string; at: number } | null = null;

/** A session for Elena, reused for ten minutes (access tokens last fifteen). */
async function elenaSession(): Promise<{ accessJwt: string; did: string; handle: string }> {
  if (!elena) throw new Error('Not ready');
  if (elenaCache && Date.now() - elenaCache.at < 10 * 60 * 1000) return elenaCache;
  const s = await session(elena.login, elena.password);
  elenaCache = { ...s, at: Date.now() };
  return s;
}

// ---------- Offline stack ----------

let plc: ChildProcess | null = null;
let pds: ChildProcess | null = null;
let pdsB: ChildProcess | null = null;
let admin = { handle: 'admin', email: 'admin@newsroom.demo', password: '' };
let adminB = { ...admin };
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

function startPds(name: string, port: number, database: string, serviceDid: string, who: typeof admin): ChildProcess {
  return start(name, ['--import', './scripts/register-ts-node.mjs', 'src/index.ts'], {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    DB_NAME: database,
    PDS_HOSTNAME: 'localhost',
    PDS_SERVICE_URL: `http://localhost:${port}`,
    PDS_SERVICE_DID: serviceDid,
    PLC_DIRECTORY_URL: stack.plcUrl,
    HANDLE_SUFFIX,
    BOOTSTRAP_ADMIN_EMAIL: who.email,
    BOOTSTRAP_ADMIN_HANDLE: who.handle,
    BOOTSTRAP_ADMIN_PASSWORD: who.password,
    GLOBAL_RATE_LIMIT: '100000',
    CREATE_RATE_LIMIT: '10000',
    PSEUDONYM_PROBATION_DAYS: '7',
  });
}

/** A custodial account: the server makes and holds its keys. */
async function seedAccount(adminJwt: string, handle: string, email: string): Promise<Person> {
  const invite = await xrpc<{ code: string }>('net.openfederation.invite.create', { maxUses: 1 }, adminJwt);
  const password = strongPassword();
  const reg = await xrpc<{ userId?: string; id?: string }>('net.openfederation.account.register', {
    handle, email, password, inviteCode: invite.code,
  });
  await xrpc('net.openfederation.account.approve', { userId: reg.userId || reg.id }, adminJwt);
  const s = await session(email, password);
  return { did: s.did, login: email, password, handle: s.handle, custody: 'custodial' };
}

/**
 * A `self` account (ADR-003), registered the way the dashboard does it
 * (registerWithOwnKeys): a twelve-word phrase made here, its rotation key
 * first and only in the DID, its owner key as openfederation_owner, the
 * signing key reserved on the server; then registerSelfCustody and approval.
 */
async function seedSelfAccount(adminJwt: string, label: string, email: string): Promise<Person> {
  const phrase = generateCustodyPhrase();
  const keys = deriveCustodyKeys(phrase);
  const { signingKey } = await xrpc<{ signingKey: string }>('com.atproto.server.reserveSigningKey', {});
  const genesis = signPlcOperation(buildCustodyGenesisOp({
    mode: 'self', userRotationDidKey: keys.rotationDidKey, atprotoDidKey: signingKey, ownerDidKey: keys.ownerDidKey,
    handle: `${label}${stack.a.handleSuffix}`, pdsEndpoint: stack.a.serviceUrl,
  }), keys.rotationPrivateKey);
  const did = didForGenesisOp(genesis);
  await submitPlcOperation(stack.plcUrl, did, genesis);
  const invite = await xrpc<{ code: string }>('net.openfederation.invite.create', { maxUses: 1 }, adminJwt);
  const password = strongPassword();
  const reg = await xrpc<{ id: string }>('net.openfederation.account.registerSelfCustody', {
    did, mode: 'self', handle: label, email, password, inviteCode: invite.code,
  });
  await xrpc('net.openfederation.account.approve', { userId: reg.id }, adminJwt);
  const s = await session(email, password);
  return { did: s.did, login: email, password, handle: s.handle, custody: 'self', phrase };
}

/** Elena, the reporter (her own keys), and Marko (custodial), who later tries to claim Night Desk as his. */
async function seedPeople(): Promise<void> {
  const adminJwt = (await session(admin.handle, admin.password)).accessJwt;
  elena = await seedSelfAccount(adminJwt, ELENA.handle.slice(0, -HANDLE_SUFFIX.length), ELENA.email);
  const m = await seedAccount(adminJwt, MARKO.handle, MARKO.email);
  marko = { did: m.did, login: m.login, password: m.password };
}

let state: 'starting' | 'ready' | 'resetting' | 'failed' = 'starting';
let lastError = '';

async function bringUpOffline(): Promise<void> {
  await Promise.all([stop(pds), stop(pdsB), stop(plc)]);
  await Promise.all([freshDatabase(DEMO_DB), freshDatabase(DEMO_DB_B)]);
  admin = { ...admin, password: strongPassword() };
  adminB = { ...admin, password: strongPassword() };
  plc = start('plc', ['node_modules/@did-plc/server/dist/bin.js'], { ...process.env, PORT: String(PORTS.plc), DATABASE_URL: '' });
  await waitFor(`${stack.plcUrl}/_health`, 'PLC directory');
  pds = startPds('pds', PORTS.pds, DEMO_DB, SERVICE_DID, admin);
  pdsB = startPds('pds-b', PORTS.pdsB, DEMO_DB_B, SERVICE_DID_B, adminB);
  await Promise.all([waitFor(`${stack.a.url}/health`, 'PDS', 120000), waitFor(`${stack.b.url}/health`, 'Second PDS', 120000)]);
  await Promise.all([describe(stack.a), describe(stack.b)]);
  await seedPeople();
}

// ---------- Live: pre-flight ----------

interface Check { id: string; label: string; ok: boolean | null; detail: string }
let checks: Check[] = [];

const OFFLINE_HINT = 'Start the offline demo instead: npm run demo';

/** Everything the live run needs, checked with reads only (and one sign-in for Elena). */
async function preflight(): Promise<Check[]> {
  const out: Check[] = [];
  const add = (id: string, label: string, ok: boolean | null, detail: string) => { out.push({ id, label, ok, detail }); };
  const reach = async (id: string, label: string, server: Server) => {
    try {
      await describe(server);
      add(id, `${label} reachable`, true, `${host(server.url)} · ${server.serviceDid} · handles ${server.handleSuffix}`);
      return true;
    } catch (err) {
      add(id, `${label} reachable`, false, `${host(server.url)}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
  const [aUp, bUp] = await Promise.all([reach('a', 'Server A', stack.a), reach('b', 'Server B', stack.b)]);
  try {
    await getJson(`${stack.plcUrl}/_health`);
    add('plc', 'Directory reachable', true, host(stack.plcUrl));
  } catch (err) {
    add('plc', 'Directory reachable', false, `${host(stack.plcUrl)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const [id, label, server, up] of [['a-config', 'Server A', stack.a, aUp], ['b-config', 'Server B', stack.b, bUp]] as const) {
    if (!up) continue;
    const c = server.config;
    const ok = c?.identity?.pseudonymsEnabled === true && c?.migration?.pseudonyms === 'open';
    add(id, `${label}: pseudonyms on, pseudonym moves open`, ok, c
      ? `pseudonyms ${c.identity?.pseudonymsEnabled ? 'on' : 'off'}, moves ${c.migration?.pseudonyms ?? 'unknown'}`
      : 'getPublicConfig did not answer');
  }

  const who = REHEARSAL ? `DEMO_REHEARSAL_${REHEARSAL}_` : 'DEMO_ELENA_';
  const login = LIVE[`${who}HANDLE`] || LIVE[`${who}EMAIL`];
  const password = LIVE[`${who}PASSWORD`];
  const expectedDid = LIVE[`${who}DID`];
  elena = null;
  elenaCache = null;
  if (!login || !password) {
    add('elena', 'Elena can sign in', false, `${who}HANDLE and ${who}PASSWORD are not set in ${LIVE_ENV_FILE}`);
  } else if (aUp) {
    try {
      // createSession looks handles up without the server's domain: "elena", not "elena.openfederation.net".
      const signInAs = !login.includes('@') && login.endsWith(stack.a.handleSuffix) ? login.slice(0, -stack.a.handleSuffix.length) : login;
      const s = await session(signInAs, password);
      if (expectedDid && s.did !== expectedDid) throw new Error(`signed in as ${s.did}, but ${who}DID is ${expectedDid}`);
      // Her server says which custody mode the account has; it decides who signs her half of the reveal.
      const level = await xrpc<{ custodyMode?: Custody | null }>('net.openfederation.account.getSecurityLevel', undefined, s.accessJwt);
      elena = { did: s.did, login: signInAs, password, handle: s.handle, custody: level.custodyMode ?? 'custodial' };
      elenaCache = { ...s, at: Date.now() };
      add('elena', `${REHEARSAL ? `Rehearsal account ${REHEARSAL}` : 'Elena'} can sign in`, true, `${s.handle} · ${s.did} · ${elena.custody}`);
    } catch (err) {
      add('elena', 'Elena can sign in', false, err instanceof Error ? err.message.slice(0, 200) : String(err));
    }
  }

  // A `self` or `assisted` Elena signs her half of the reveal with her own
  // owner key, from her identity phrase: check the phrase is this DID's.
  if (elena && elena.custody !== 'custodial') {
    const phrase = LIVE[`${who}PHRASE`];
    const label = 'Elena’s own key matches her DID';
    if (!phrase) {
      add('elena-keys', label, false, `${elena.custody} account: ${who}PHRASE (her twelve-word identity phrase) is not set in ${LIVE_ENV_FILE}`);
    } else {
      try {
        const keys = deriveCustodyKeys(phrase);
        const data = await getJson<{ rotationKeys: string[]; verificationMethods: Record<string, string> }>(`${stack.plcUrl}/${elena.did}/data`);
        const rotationOk = data.rotationKeys[0] === keys.rotationDidKey;
        const ownerOk = data.verificationMethods.openfederation_owner === keys.ownerDidKey;
        if (rotationOk && ownerOk) elena.phrase = phrase;
        add('elena-keys', label, rotationOk && ownerOk, rotationOk && ownerOk
          ? `${elena.custody}: the phrase holds the DID’s first rotation key and its owner key; Elena signs her half herself`
          : `${who}PHRASE does not match ${elena.did}: ${rotationOk ? '' : 'first rotation key differs; '}${ownerOk ? '' : 'owner key differs'}`.replace(/; $/, ''));
      } catch (err) {
        add('elena-keys', label, false, err instanceof Error && err.message === 'InvalidPhrase' ? `${who}PHRASE is not a valid twelve-word phrase` : String(err instanceof Error ? err.message : err));
      }
    }
  } else if (elena) {
    add('elena-keys', 'Elena’s half of the reveal', null, 'custodial account: her server signs it with the key it holds for her (“signed by the server’s key”)');
  }

  // The browser registers Night Desk with stack.plcUrl, and both servers must
  // read the same directory: compare what each URL says about Elena's DID.
  if (elena && aUp && bUp) {
    const urls = [...new Set([stack.plcUrl, stack.a.config?.plcDirectoryUrl, stack.b.config?.plcDirectoryUrl]
      .filter((u): u is string => !!u).map(trimUrl))];
    try {
      const docs = await Promise.all(urls.map((u) => getJson(`${u}/${elena!.did}/log/last`).then((j) => JSON.stringify(j))));
      const same = docs.every((d) => d === docs[0]);
      const last = JSON.parse(docs[0]) as { services?: { atproto_pds?: { endpoint?: string } } };
      const endpoint = trimUrl(last.services?.atproto_pds?.endpoint ?? '');
      const home = endpoint === stack.a.serviceUrl;
      add('same-plc', 'Both servers use this directory', same && home, same
        ? home ? `${urls.map(host).join(' = ')}; Elena lives on ${host(endpoint)}` : `Elena's DID names ${endpoint || 'no server'}, not server A`
        : `${urls.map(host).join(', ')} disagree about Elena's DID`);
    } catch (err) {
      add('same-plc', 'Both servers use this directory', false, err instanceof Error ? err.message : String(err));
    }
  }

  // Marko's DID, for "Marko claims Night Desk". Only his public DID is needed.
  marko = null;
  const markoDid = LIVE.DEMO_MARKO_DID;
  const markoHandle = LIVE.DEMO_MARKO_HANDLE;
  if (markoDid) {
    marko = { did: markoDid };
    add('marko', 'Marko’s account known', true, markoDid);
  } else if (markoHandle && aUp) {
    try {
      const r = await xrpc<{ did: string }>(`com.atproto.identity.resolveHandle?handle=${encodeURIComponent(markoHandle)}`);
      marko = { did: r.did };
      add('marko', 'Marko’s account known', true, `${markoHandle} · ${r.did}`);
    } catch (err) {
      add('marko', 'Marko’s account known', false, `${markoHandle}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    add('marko', 'Marko’s account known', false, `DEMO_MARKO_DID or DEMO_MARKO_HANDLE is not set in ${LIVE_ENV_FILE}`);
  }

  // The custodial contrast: Marko reveals his own pseudonym, signed by his
  // server's key. Optional; it needs his sign-in.
  if (marko && aUp) {
    const login = LIVE.DEMO_MARKO_HANDLE;
    const password = LIVE.DEMO_MARKO_PASSWORD;
    if (!login || !password) {
      add('marko-contrast', 'Custodial contrast (Marko)', null, 'Off: set DEMO_MARKO_HANDLE and DEMO_MARKO_PASSWORD to show a reveal signed by the server’s key');
    } else {
      try {
        const signInAs = !login.includes('@') && login.endsWith(stack.a.handleSuffix) ? login.slice(0, -stack.a.handleSuffix.length) : login;
        const s = await session(signInAs, password);
        if (s.did !== marko.did) throw new Error(`signed in as ${s.did}, not ${marko.did}`);
        const level = await xrpc<{ custodyMode?: Custody | null }>('net.openfederation.account.getSecurityLevel', undefined, s.accessJwt);
        const custodial = (level.custodyMode ?? 'custodial') === 'custodial';
        if (custodial) marko = { ...marko, login: signInAs, password };
        add('marko-contrast', 'Custodial contrast (Marko)', custodial ? true : null, custodial ? `${s.handle} can sign in; custodial` : `Off: Marko’s account is ${level.custodyMode}, not custodial`);
      } catch (err) {
        // Optional: never blocks the show.
        add('marko-contrast', 'Custodial contrast (Marko)', null, `Off: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
      }
    }
  }

  // Passes: the server cannot say how many are left (it never sees which
  // were used); this laptop can, once it has collected them.
  if (elena) {
    const w = readWallet(elena.did);
    if (w) {
      const left = w.tokens.length - w.spent;
      add('passes', 'Passes left this month', left > 0, `${left} of ${w.tokens.length} on this laptop`);
    } else {
      add('passes', 'Passes left this month', null, 'Not collected on this laptop yet this month; the Passes screen collects 20. A second collection in the same month is refused.');
    }
  }
  if (REHEARSAL) {
    add('rehearsal', 'Rehearsal: words kept for cleanup', true, `${REHEARSALS_FILE} · npm run demo -- --cleanup`);
  }
  return out;
}

async function bringUpLive(): Promise<void> {
  checks = await preflight();
  const red = checks.filter((c) => c.ok === false);
  if (red.length) {
    throw new Error(`Pre-flight: ${red.map((c) => `${c.label}: ${c.detail}`).join(' · ')}. ${OFFLINE_HINT}`);
  }
}

async function bringUp(): Promise<void> {
  state = state === 'starting' ? 'starting' : 'resetting';
  elena = null;
  marko = null;
  elenaCache = null;
  pseudonymDids = new Set();
  contrast = null;
  try {
    if (MODE === 'live') await bringUpLive(); else await bringUpOffline();
    state = 'ready';
    lastError = '';
    console.log(`Ready (${MODE}). Open http://localhost:${PORTS.app}`);
  } catch (err) {
    state = 'failed';
    lastError = err instanceof Error ? err.message : String(err);
    console.error('Demo stack failed:', lastError);
  }
  if (MODE === 'live') {
    for (const c of checks) console.log(`  ${c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : '--  '} ${c.label}: ${c.detail}`);
  }
}

// ---------- Live: what this laptop keeps ----------

interface Wallet { epoch: string; tokens: CreationToken[]; spent: number }
interface Rehearsal {
  did: string; handle: string; phrase: string; plcUrl: string;
  servers: { url: string; serviceDid: string }[];
  createdAt: string; movedTo?: string; cleanedAt?: string;
  /** 'contrast': Marko's Late Shift, kept for every run until --cleanup; ownerDid is Marko's. */
  role?: 'contrast'; ownerDid?: string;
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(LIVE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** This month's passes for an account, if this laptop collected them. */
function readWallet(did: string): Wallet | null {
  const w = readJson<Record<string, Wallet>>(WALLETS_FILE, {})[did];
  return w && w.epoch === currentEpoch() ? w : null;
}

// ---------- What the server knows (offline: its database) ----------

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

// ---------- What anyone can see (live: the public record) ----------

interface AuditEntry { createdAt: string; nullified: boolean; operation: Record<string, any> }

/** One account's public record: its PLC history and the repository its DID points to. */
async function publicRecord(did: string) {
  if (!isPlcDid(did)) throw new Error('Not a did:plc');
  const audit = (await getJson<AuditEntry[]>(`${stack.plcUrl}/${did}/log/audit`)).filter((e) => !e.nullified);
  const entries = audit.map((e) => {
    const op = e.operation;
    if (op.type === 'plc_tombstone') return { at: e.createdAt, kind: 'tombstone' as const };
    const handle = (op.alsoKnownAs as string[] | undefined)?.find((a) => a.startsWith('at://'))?.slice(5) ?? op.handle;
    const endpoint = op.services?.atproto_pds?.endpoint ?? op.service;
    return {
      at: e.createdAt, kind: op.prev ? 'update' as const : 'create' as const, handle, endpoint,
      rotationKeys: (op.rotationKeys as string[] | undefined)?.length ?? 0,
      sealedNote: ((op.alsoKnownAs as string[] | undefined) ?? []).some((a) => a.startsWith('urn:openfederation:pseudonym-commitment:')),
    };
  });
  const last = [...entries].reverse().find((e) => e.kind !== 'tombstone');
  const endpoint = last && 'endpoint' in last ? trimUrl(last.endpoint ?? '') : '';
  const collections: { name: string; files: number }[] = [];
  const values: unknown[] = [];
  // Read repositories only from the two servers this demo is configured for:
  // the endpoint comes from the DID's PLC entry, which its owner controls.
  const known = [stack.a.url, stack.b.url].map(trimUrl);
  if (endpoint && known.includes(endpoint)) {
    const repo = await getJson<{ collections: string[] }>(`${endpoint}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`);
    for (const c of repo.collections) {
      const r = await getJson<{ records: { value: unknown }[] }>(
        `${endpoint}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({ repo: did, collection: c, limit: '100' })}`);
      collections.push({ name: c, files: r.records.length });
      values.push(...r.records.map((x) => x.value));
    }
  }
  return {
    did, handle: last && 'handle' in last ? last.handle : undefined, endpoint, entries, collections,
    text: JSON.stringify([audit, values]),
  };
}

async function publicView(pseudonymDid: string | undefined) {
  if (!elena) throw new Error('Not ready');
  const [e, n] = await Promise.all([publicRecord(elena.did), pseudonymDid ? publicRecord(pseudonymDid) : Promise.resolve(null)]);
  const names = (text: string, who: { did: string; handle?: string }) =>
    text.includes(who.did) || (!!who.handle && text.includes(who.handle));
  const strip = ({ text: _t, ...rest }: Awaited<ReturnType<typeof publicRecord>>) => rest;
  return {
    elena: { ...strip(e), namesOther: n ? names(e.text, n) : false },
    nightDesk: n ? { ...strip(n), namesOther: names(n.text, e) } : null,
    search: {
      entries: e.entries.length + (n?.entries.length ?? 0),
      files: [e, n].reduce((s, x) => s + (x?.collections.reduce((t, c) => t + c.files, 0) ?? 0), 0),
    },
  };
}

// ---------- Handles ----------

/** Is `label` free on this server (under its own handle domain)? */
async function handleFree(server: Server, label: string): Promise<boolean> {
  const res = await fetch(`${server.url}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(label + server.handleSuffix)}`,
    { signal: AbortSignal.timeout(15000) });
  if (res.ok) return false;
  if (res.status === 400 || res.status === 404) return true;
  throw new Error(`resolveHandle on ${host(server.url)} answered ${res.status}`);
}

/**
 * Night Desk's handle label, free on both servers: "nightdesk" for the show,
 * "nightdesk-rehearsal" for rehearsals, numbered when an earlier run kept it.
 * The label goes into the PLC genesis, so it is checked before anything is written.
 */
async function freeLabel(name = 'nightdesk'): Promise<string> {
  const base = REHEARSAL ? `${name}-rehearsal` : name;
  for (let i = 1; i <= 50; i++) {
    const label = i === 1 ? base : `${base}-${i}`;
    if (await handleFree(stack.a, label) && await handleFree(stack.b, label)) return label;
  }
  throw new Error(`No free ${name} handle; run npm run demo -- --cleanup`);
}

// ---------- The custodial contrast: Marko's own pseudonym ----------

/**
 * Late Shift, Marko's pseudonym on server A. Marko is custodial, so his half
 * of its reveal is signed by his server's key: the contrast to Elena's.
 * Offline it is made once per stack; live, once per laptop (its words are
 * kept in rehearsals.json, so --cleanup removes it like a rehearsal).
 */
let contrast: { did: string; handle: string; phrase: string } | null = null;

async function markoSession(): Promise<{ accessJwt: string; did: string }> {
  if (!marko?.login || !marko.password) {
    throw new Error('The custodial contrast is off: set DEMO_MARKO_HANDLE and DEMO_MARKO_PASSWORD');
  }
  return session(marko.login, marko.password);
}

/** One of Marko's passes for this month: collected here (offline) or kept on this laptop (live). */
async function markoPass(accessJwt: string): Promise<{ token: CreationToken; spent: () => void }> {
  const did = marko!.did;
  let wallet = MODE === 'live' ? readWallet(did) : null;
  if (!wallet) {
    const tokens = await collectTokens({ pdsUrl: stack.a.url, accessJwt, keys: await fetchTokenKeys(stack.a.url), count: 20 });
    wallet = { epoch: tokens[0].epoch, tokens, spent: 0 };
  }
  const w = wallet;
  const keep = () => { if (MODE === 'live') { const all = readJson<Record<string, Wallet>>(WALLETS_FILE, {}); all[did] = w; writeJson(WALLETS_FILE, all); } };
  keep();
  const token = w.tokens[w.spent];
  if (!token) throw new Error('Marko has no passes left this month');
  return { token, spent: () => { w.spent += 1; keep(); } };
}

async function lateShift(): Promise<NonNullable<typeof contrast>> {
  if (contrast) return contrast;
  if (!marko) throw new Error('Not ready');
  if (MODE === 'live') {
    const kept = readJson<Rehearsal[]>(REHEARSALS_FILE, [])
      .find((r) => r.role === 'contrast' && r.ownerDid === marko!.did && !r.cleanedAt && r.plcUrl === stack.plcUrl && r.phrase);
    if (kept) return (contrast = { did: kept.did, handle: kept.handle, phrase: kept.phrase });
  }
  const s = await markoSession();
  const pass = await markoPass(s.accessJwt);
  const label = MODE === 'live' ? await freeLabel(LATE_SHIFT.label) : LATE_SHIFT.label;
  const handle = `${label}${stack.a.handleSuffix}`;
  const phrase = generatePseudonymPhrase();
  const keys = derivePseudonymKeys(phrase);
  const { signingKey } = await xrpc<{ signingKey: string }>('com.atproto.server.reserveSigningKey', {});
  const signed = signGenesisOp(buildPseudonymGenesisOp({
    ownerDidKey: keys.ownerDidKey, signingDidKey: signingKey, handle,
    pdsEndpoint: stack.a.serviceUrl, ownerDid: marko.did, commitmentSaltHex: keys.commitmentSaltHex,
  }), keys.ownerPrivateKey);
  const did = didForSignedOp(signed);
  if (MODE === 'live') {
    // Kept before the DID exists anywhere, so cleanup can always find it.
    const all = readJson<Rehearsal[]>(REHEARSALS_FILE, []);
    all.push({
      did, handle, phrase, plcUrl: stack.plcUrl, createdAt: new Date().toISOString(), role: 'contrast', ownerDid: marko.did,
      servers: [stack.a, stack.b].map((x) => ({ url: x.url, serviceDid: x.serviceDid })),
    });
    writeJson(REHEARSALS_FILE, all);
  }
  const plcRes = await fetch(`${stack.plcUrl}/${did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed) });
  if (!plcRes.ok) throw new Error(`Directory refused Late Shift: ${await plcRes.text()}`);
  // No Authorization header, as for Night Desk.
  await xrpc('net.openfederation.pseudonym.createAccount', { did, token: pass.token });
  pass.spent();
  return (contrast = { did, handle, phrase });
}

// ---------- Cleanup ----------

const DELETE_ACCOUNT = 'com.atproto.server.deleteAccount';

/** Delete a pseudonym's account on one server with its own owner key. */
async function deletePseudonymAccount(server: { url: string; serviceDid: string }, r: Rehearsal): Promise<'deleted' | 'none'> {
  const attempt = async () => {
    const jwt = signOwnerJwt({ phrase: r.phrase, did: r.did, aud: server.serviceDid, lxm: DELETE_ACCOUNT });
    const res = await fetch(`${server.url}/xrpc/${DELETE_ACCOUNT}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ did: r.did }),
    });
    const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
    return { ok: res.ok, status: res.status, error: json.error ?? '', message: json.message ?? '' };
  };
  let out = await attempt();
  // A deactivated copy the DID still names (a move stopped half way): switch it back on, then delete.
  if (!out.ok && out.error === 'AccountDeactivated') {
    const s = await loginWithPhrase({ pdsUrl: server.url, phrase: r.phrase, expectedServiceDid: server.serviceDid });
    await xrpc('com.atproto.server.activateAccount', {}, s.accessJwt, server.url);
    out = await attempt();
  }
  if (out.ok) return 'deleted';
  // No pseudonym with this DID here: the server asks for a password instead.
  if (out.status === 400 && /password and token are required/.test(out.message)) return 'none';
  throw new Error(`${host(server.url)} refused (${out.status}): ${out.error} ${out.message}`.trim());
}

async function cleanup(): Promise<void> {
  const dry = arg('dry-run') !== undefined;
  const all = readJson<Rehearsal[]>(REHEARSALS_FILE, []);
  const todo = all.filter((r) => !r.cleanedAt);
  console.log(`${todo.length} rehearsal pseudonym${todo.length === 1 ? '' : 's'} to clean up (${REHEARSALS_FILE})${dry ? ', dry run' : ''}`);
  let failed = 0;
  for (const r of todo) {
    console.log(`\n${r.handle}  ${r.did}  (created ${r.createdAt}${r.movedTo ? `, moved to ${host(r.movedTo)}` : ''})`);
    if (dry) { for (const s of r.servers) console.log(`  would delete on ${host(s.url)}`); console.log(`  would tombstone on ${host(r.plcUrl)}`); continue; }
    try {
      // Accounts first: deleteAccount checks the owner key against the DID's current rotation keys.
      for (const s of r.servers) console.log(`  ${host(s.url)}: ${await deletePseudonymAccount(s, r)}`);
      try {
        await tombstone({ plcUrl: r.plcUrl, did: r.did, phrase: r.phrase });
        console.log(`  ${host(r.plcUrl)}: tombstoned`);
      } catch (err) {
        if (!(err instanceof Error && /AlreadyTombstoned/.test(err.message))) throw err;
        console.log(`  ${host(r.plcUrl)}: already tombstoned`);
      }
      r.cleanedAt = new Date().toISOString();
      // The words are no longer needed once the DID is gone.
      r.phrase = '';
      writeJson(REHEARSALS_FILE, all);
    } catch (err) {
      failed++;
      console.error(`  failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed) { console.error(`\n${failed} not cleaned; run the command again.`); process.exitCode = 1; }
}

// ---------- App server ----------

/** Where audience phones check proofs (live only): the dashboard's public verifier. */
const VERIFIER_URL = LIVE.DEMO_VERIFIER_URL || 'https://beta.openfederation.net/verify';

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

function fail(res: express.Response, err: unknown, status = 500): void {
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

async function main(): Promise<void> {
  if (MODE === 'cleanup') { await cleanup(); return; }
  await bundle();

  const app = express();
  // Only this laptop's own address may talk to the demo server. Listening on
  // 127.0.0.1 keeps other machines out; checking Host also keeps out a web
  // page whose domain is made to resolve to 127.0.0.1 (DNS rebinding), which
  // could otherwise read /api/elena-phrase.
  const allowedHosts = new Set([`localhost:${PORTS.app}`, `127.0.0.1:${PORTS.app}`]);
  app.use((req, res, next) => {
    if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return res.status(421).send('Wrong host');
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(join(HERE, 'public'), { extensions: ['html'] }));

  app.get('/api/status', (_req, res) => {
    res.json({ state, error: lastError, mode: MODE, checks });
  });

  app.get('/api/state', async (_req, res) => {
    if (state !== 'ready' || !elena) return res.status(503).json({ state, error: lastError });
    try {
      const s = await elenaSession();
      let used = { passesCollected: false, pseudonymExists: false };
      if (MODE === 'offline') {
        const client = new pg.Client({ ...db, database: DEMO_DB });
        await client.connect();
        try {
          const b = await client.query('SELECT count(*)::int AS n FROM pseudonym_token_batches');
          const p = await client.query("SELECT count(*)::int AS n FROM users WHERE auth_type = 'pseudonym'");
          used = { passesCollected: b.rows[0].n > 0, pseudonymExists: p.rows[0].n > 0 };
        } finally {
          await client.end();
        }
      }
      res.json({
        mode: MODE, rehearsal: REHEARSAL > 0, used, checks,
        plcUrl: stack.plcUrl,
        pdsUrl: stack.a.url, serviceDid: stack.a.serviceDid, handleSuffix: stack.a.handleSuffix, pdsServiceUrl: stack.a.serviceUrl,
        pdsBUrl: stack.b.url, pdsBServiceDid: stack.b.serviceDid, pdsBHandleSuffix: stack.b.handleSuffix,
        elena: { did: s.did, handle: s.handle, name: ELENA.name, accessJwt: s.accessJwt, custody: elena.custody },
        impostor: { did: marko!.did, name: MARKO.name, contrast: !!marko!.login },
        contrastName: LATE_SHIFT.name,
        // Phones can only reach the verifier when the servers are public.
        verifierUrl: MODE === 'live' ? VERIFIER_URL : null,
        presenceContext: PRESENCE_CONTEXT,
        wallet: MODE === 'live' ? readWallet(s.did) : null,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** A fresh access token for Elena, for steps that come a while after the page loaded. */
  app.get('/api/elena-session', async (_req, res) => {
    try { res.json({ accessJwt: (await elenaSession()).accessJwt }); } catch (err) { fail(res, err); }
  });

  /**
   * Elena's identity phrase, for her laptop (this page) to sign her half of
   * the reveal: only for an account that holds its own keys, only to
   * localhost (the app listens on 127.0.0.1). Never logged.
   */
  app.get('/api/elena-phrase', (_req, res) => {
    if (!elena || elena.custody === 'custodial' || !elena.phrase) return res.status(404).json({ error: 'Elena’s server signs for her (custodial)' });
    res.set('Cache-Control', 'no-store').json({ phrase: elena.phrase });
  });

  app.get('/api/free-handle', async (_req, res) => {
    try { res.json({ label: await freeLabel() }); } catch (err) { fail(res, err); }
  });

  app.get('/api/server-view', async (req, res) => {
    try {
      const did = isPlcDid(req.query.pseudonym) ? req.query.pseudonym : undefined;
      if (did) pseudonymDids.add(did);
      if (MODE === 'live') res.json({ view: 'public', ...(await publicView(did)) });
      else res.json({ view: 'database', ...(await serverView(did)) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Live: Elena's passes stay on this laptop across resets and restarts.
  app.post('/api/wallet', (req, res) => {
    if (MODE !== 'live' || !elena) return res.status(404).json({ error: 'Live mode only' });
    const { tokens, spent } = req.body ?? {};
    if (!Array.isArray(tokens) || !tokens.length || typeof spent !== 'number' || spent < 0 || spent > tokens.length) {
      return res.status(400).json({ error: 'tokens and spent are required' });
    }
    const all = readJson<Record<string, Wallet>>(WALLETS_FILE, {});
    all[elena.did] = { epoch: (tokens[0] as CreationToken).epoch, tokens, spent };
    writeJson(WALLETS_FILE, all);
    res.json({ ok: true });
  });

  // Live rehearsals only: keep the words so --cleanup can delete and tombstone later.
  app.post('/api/rehearsal', (req, res) => {
    if (MODE !== 'live' || !REHEARSAL) return res.status(403).json({ error: 'Words are kept only in a live rehearsal' });
    const { did, handle, phrase, movedTo } = req.body ?? {};
    if (!isPlcDid(did)) return res.status(400).json({ error: 'did is required' });
    const all = readJson<Rehearsal[]>(REHEARSALS_FILE, []);
    const existing = all.find((r) => r.did === did);
    if (existing) {
      if (typeof movedTo === 'string') existing.movedTo = movedTo;
    } else {
      if (typeof phrase !== 'string' || typeof handle !== 'string') return res.status(400).json({ error: 'handle and phrase are required' });
      all.push({
        did, handle, phrase, plcUrl: stack.plcUrl, createdAt: new Date().toISOString(),
        servers: [stack.a, stack.b].map((s) => ({ url: s.url, serviceDid: s.serviceDid })),
      });
    }
    writeJson(REHEARSALS_FILE, all);
    res.json({ ok: true });
  });

  // The independent verifier: it knows only the pseudonym's DID, the word the
  // audience called out and the signature. It takes the public key from the
  // PLC directory, never from the device being checked.
  app.post('/api/verify-presence', async (req, res) => {
    const { pseudonymDid, word, signature } = req.body ?? {};
    if (!isPlcDid(pseudonymDid) || typeof word !== 'string' || !word.trim() || typeof signature !== 'string') {
      return res.status(400).json({ error: 'pseudonymDid, word and signature are required' });
    }
    // The same code as the /verify page on the audience's phones (@open-federation/pseudonym).
    const challenge = challengeForWord(word, PRESENCE_CONTEXT);
    res.json({ ...(await checkPresence({ plcUrl: stack.plcUrl, pseudonymDid, challenge, signature })), challenge });
  });

  // Checks a reveal the way `ofc pseudonym verify --online` does: the bundle,
  // plus both DIDs resolved from the PLC directory. Same code as /verify.
  app.post('/api/verify-reveal', async (req, res) => {
    res.json(await verifyRevealBundle(req.body?.bundle, { online: true, plcUrl: stack.plcUrl }));
  });

  // The custodial contrast: Marko reveals his own pseudonym, Late Shift. His
  // server signs his half (net.openfederation.pseudonym.signLink).
  app.post('/api/contrast-reveal', async (_req, res) => {
    try {
      if (state !== 'ready' || !marko) throw new Error('Not ready');
      const c = await lateShift();
      const s = await markoSession();
      const bundle = await createRevealBundle({
        pdsUrl: stack.a.url, plcUrl: stack.plcUrl, phrase: c.phrase, pseudonymDid: c.did, ownerDid: marko.did, ownerAccessJwt: s.accessJwt,
      });
      res.json({ bundle, handle: c.handle });
    } catch (err) {
      fail(res, err);
    }
  });

  // Offline: rebuild the databases and directory. Live: forget this run's
  // state here and run the pre-flight again; nothing on the servers changes.
  app.post('/api/reset', (_req, res) => {
    if (state === 'resetting' || state === 'starting') return res.json({ state });
    state = 'resetting';
    void bringUp();
    res.json({ state });
  });

  app.listen(PORTS.app, '127.0.0.1', () => {
    console.log(`Stage app: http://localhost:${PORTS.app} (${MODE === 'live' ? `live: ${host(stack.a.url)} → ${host(stack.b.url)}, running the pre-flight` : 'starting the stack'}…)`);
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
