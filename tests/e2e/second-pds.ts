/**
 * A second PDS for migration E2E tests: its own process, port, database,
 * service DID and handle suffix, sharing the local PLC directory with the
 * in-process test server. Start it in beforeAll and stop it in afterAll.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '../../src/config.js';

export interface SecondPds {
  url: string;
  serviceDid: string;
  handleSuffix: string;
  stop(): Promise<void>;
}

const ROOT = process.cwd();
const PORT = Number(process.env.TEST_PDS_B_PORT || 8093);
const DB_NAME = `${process.env.TEST_DB_NAME || 'openfederation_pds_test'}_b`;

async function freshDatabase(): Promise<void> {
  const client = new pg.Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: 'postgres',
  });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await client.end();
  }
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs = 120_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`Second PDS exited (${child.exitCode}); see tests/e2e/.logs/pds-b.log`);
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Second PDS did not start; see tests/e2e/.logs/pds-b.log');
}

/** Start PDS B on a fresh database; the server applies the schema itself. */
export async function startSecondPds(): Promise<SecondPds> {
  await freshDatabase();
  const url = `http://localhost:${PORT}`;
  const serviceDid = `did:web:localhost%3A${PORT}`;
  const handleSuffix = '.pds-b.test';
  const logDir = join(ROOT, 'tests', 'e2e', '.logs');
  mkdirSync(logDir, { recursive: true });
  rmSync(join(logDir, 'pds-b-blobs'), { recursive: true, force: true });
  const log = createWriteStream(join(logDir, 'pds-b.log'), { flags: 'w' });

  const child = spawn(process.execPath, ['--import', './scripts/register-ts-node.mjs', 'src/index.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      DB_NAME,
      PDS_HOSTNAME: 'localhost',
      PDS_SERVICE_URL: url,
      PDS_SERVICE_DID: serviceDid,
      PLC_DIRECTORY_URL: config.plc.directoryUrl,
      HANDLE_SUFFIX: handleSuffix,
      // Its own blob store, so a moved blob is really copied.
      BLOB_STORAGE: 'local',
      BLOB_STORAGE_PATH: join(logDir, 'pds-b-blobs'),
      BOOTSTRAP_ADMIN_HANDLE: 'admin',
      BOOTSTRAP_ADMIN_EMAIL: 'admin@pds-b.test',
      BOOTSTRAP_ADMIN_PASSWORD: 'Second-Pds-Admin-7a!',
      GLOBAL_RATE_LIMIT: '100000',
      CREATE_RATE_LIMIT: '10000',
    },
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  try {
    await waitForHealth(url, child);
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }

  return {
    url,
    serviceDid,
    handleSuffix,
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 4000);
    }),
  };
}
