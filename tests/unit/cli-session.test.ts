/**
 * The CLI's stored session: always private on disk, never thrown away because
 * a refresh merely failed to get through, and shared sanely between two
 * invocations running at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OFCClient, saveSession, loadSession } from '../../cli/ofc-client.js';

const SERVER = 'http://127.0.0.1:9';
const session = (n: number) => ({ serverUrl: SERVER, accessJwt: `access-${n}`, refreshJwt: `refresh-${n}`, did: 'did:plc:x', handle: 'x' });

describe('CLI session file', () => {
  let dir: string;
  const previous = process.env.XDG_CONFIG_HOME;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ofc-')); process.env.XDG_CONFIG_HOME = dir; });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const file = () => join(dir, 'ofc', 'session.json');
  const refreshAs = (client: OFCClient, s: ReturnType<typeof session>) =>
    (client as unknown as { tryRefresh: (s: unknown) => Promise<unknown> }).tryRefresh(s);

  it('is private even when the file already existed with looser permissions', () => {
    mkdirSync(join(dir, 'ofc'), { recursive: true });
    writeFileSync(file(), '{}');
    chmodSync(file(), 0o644);
    saveSession(session(1));
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('keeps the session when a refresh fails for a reason that is not about the token', async () => {
    for (const failure of [
      async () => new Response('{}', { status: 503 }),
      async () => new Response('{}', { status: 429 }),
      async () => { throw new TypeError('fetch failed'); },
    ]) {
      saveSession(session(1));
      vi.stubGlobal('fetch', vi.fn(failure));
      expect(await refreshAs(new OFCClient(SERVER), session(1))).toBeNull();
      expect(loadSession(SERVER)?.refreshJwt).toBe('refresh-1');
    }
  });

  it('clears the session when the server refuses the refresh token', async () => {
    saveSession(session(1));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    expect(await refreshAs(new OFCClient(SERVER), session(1))).toBeNull();
    expect(loadSession(SERVER)).toBeNull();
  });

  it('uses the session another invocation has already refreshed instead of replaying the old token', async () => {
    saveSession(session(2)); // a concurrent `ofc` already rotated 1 -> 2
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await refreshAs(new OFCClient(SERVER), session(1)) as { refreshJwt: string } | null;
    expect(result?.refreshJwt).toBe('refresh-2');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
