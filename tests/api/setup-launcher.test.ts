/**
 * The real entry point (src/index.ts) in a child process (#405):
 *  - production with no secrets starts in setup mode, prints a setup code,
 *    and serves only the wizard;
 *  - a half-configured production install still refuses to start, as before;
 *  - with the wizard's settings file present, the server starts normally and
 *    the file's settings are what it runs with (an environment variable
 *    overriding one of them wins).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { writeConfigFile } from '../../src/setup/config-file.js';
import { generateSecrets } from '../../src/setup/secrets.js';

const ROOT = resolve(__dirname, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'of-launch-'));
const children: ChildProcess[] = [];

afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

/** A clean environment: only what a fresh container would have. */
function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DB_HOST: process.env.DB_HOST || 'localhost',
    DB_PORT: process.env.DB_PORT || '5432',
    DB_NAME: process.env.DB_NAME,
    DB_USER: process.env.DB_USER || 'postgres',
    DB_PASSWORD: process.env.DB_PASSWORD || '',
    PLC_DIRECTORY_URL: 'http://localhost:2582',
    ...extra,
  };
}

function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', './scripts/register-ts-node.mjs', 'src/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout!.on('data', (d) => { output += d; });
  child.stderr!.on('data', (d) => { output += d; });
  const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
  async function waitFor(pattern: RegExp, ms = 60_000): Promise<RegExpMatchArray> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const m = output.match(pattern);
      if (m) return m;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Did not see ${pattern} in:\n${output}`);
  }
  return { child, exited, waitFor, output: () => output };
}

describe('the entry point', () => {
  it('a fresh production install starts in setup mode and serves only the wizard', async () => {
    const port = await freePort();
    const proc = start(baseEnv({ NODE_ENV: 'production', PORT: String(port), OPENFEDERATION_CONFIG_FILE: join(dir, 'fresh', 'openfederation.env') }));
    const code = await proc.waitFor(/Setup code: ([0-9A-Z]{5}(?:-[0-9A-Z]{5}){3})/);
    expect(code[1]).toBeTruthy();
    await proc.waitFor(/Setup server listening/);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.status).toBe('setup');
    const xrpc = await fetch(`http://127.0.0.1:${port}/xrpc/com.atproto.server.describeServer`);
    expect(xrpc.status).toBe(503);
    proc.child.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
  }, 90_000);

  it('a half-configured production install still refuses to start, exactly as before', async () => {
    const proc = start(baseEnv({ NODE_ENV: 'production', PORT: String(await freePort()), AUTH_JWT_SECRET: 'x'.repeat(64), OPENFEDERATION_CONFIG_FILE: join(dir, 'none', 'openfederation.env') }));
    expect(await proc.exited).toBe(1);
    expect(proc.output()).toMatch(/FATAL/);
    expect(proc.output()).not.toMatch(/Setup code/);
  }, 90_000);

  it('with the settings file, the server starts normally with its settings; environment variables win', async () => {
    const port = await freePort();
    const file = join(dir, 'done', 'openfederation.env');
    writeConfigFile(file, {
      ...generateSecrets(),
      PDS_SERVICE_URL: 'https://from-file.example',
      PDS_HOSTNAME: 'from-file.example',
      HANDLE_SUFFIX: '.from-file.example',
      ALLOW_NO_EMAIL: 'true',
      OPENFEDERATION_PROFILE: 'privacy',
    });
    const proc = start(baseEnv({ NODE_ENV: 'production', PORT: String(port), OPENFEDERATION_CONFIG_FILE: file, PDS_SERVICE_URL: 'https://from-env.example', GLOBAL_RATE_LIMIT: '100000' }));
    await proc.waitFor(/OpenFederation PDS is running/);
    expect(proc.output()).toMatch(/Loaded \d+ setting\(s\) from .*openfederation\.env; 1 more are set by environment variables/);
    expect(proc.output()).toMatch(/PDS Service URL: https:\/\/from-env\.example/);
    expect(proc.output()).not.toMatch(/Setup code/);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.status).not.toBe('setup');
    const describe = await (await fetch(`http://127.0.0.1:${port}/xrpc/com.atproto.server.describeServer`)).json();
    expect(describe.availableUserDomains).toEqual(['.from-file.example']);
    proc.child.kill('SIGTERM');
    await proc.exited;
  }, 120_000);
});
