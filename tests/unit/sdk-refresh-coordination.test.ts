/**
 * Refreshing a session in the SDK: tabs sharing storage take turns, and only a
 * definitive refusal from the server signs the user out.
 */
import { describe, it, expect } from 'vitest';
import { TokenManager } from '../../packages/openfederation-sdk/src/auth.js';
import { MemoryStorageAdapter } from '../../packages/openfederation-sdk/src/storage.js';
import { coordinatedRefresh } from '../../packages/openfederation-sdk/src/refresh.js';

const user = { did: 'did:plc:abc', handle: 'a.example', email: '', active: true };

function jwt(expInSec: number): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expInSec })}.sig`;
}

/** What `navigator.locks.request` gives real tabs: one holder at a time. */
function sharedLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(_name: string, fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

function ok(n: number): Response {
  return new Response(JSON.stringify({ ...user, accessJwt: jwt(900), refreshJwt: `refresh-${n}` }), { status: 200 });
}

describe('SDK refresh coordination', () => {
  it('two tabs holding the same token make one refresh call; the second adopts the result', async () => {
    const storage = new MemoryStorageAdapter();
    const tabA = new TokenManager(storage, 'of_');
    const tabB = new TokenManager(storage, 'of_');
    tabA.setTokens(jwt(30), 'refresh-0', user);
    const lock = sharedLock();
    const sent: string[] = [];
    const doFetch = async (refreshJwt: string) => {
      sent.push(refreshJwt);
      await new Promise((r) => setTimeout(r, 20));
      return ok(sent.length);
    };

    const outcomes = await Promise.all([
      coordinatedRefresh({ tokens: tabA, doFetch, lock }),
      coordinatedRefresh({ tokens: tabB, doFetch, lock }),
    ]);

    expect(sent).toEqual(['refresh-0']);
    expect(outcomes.sort()).toEqual(['adopted', 'refreshed']);
    expect(tabB.getRefreshJwt()).toBe('refresh-1');
    tabA.destroy(); tabB.destroy();
  });

  it('keeps the session when the server is busy or failing', async () => {
    for (const status of [429, 500, 502, 503]) {
      const tokens = new TokenManager(new MemoryStorageAdapter(), 'of_');
      tokens.setTokens(jwt(30), 'refresh-0', user);
      const outcome = await coordinatedRefresh({ tokens, doFetch: async () => new Response('{}', { status }), lock: sharedLock() });
      expect(outcome, String(status)).toBe('retry-later');
      expect(tokens.getRefreshJwt(), String(status)).toBe('refresh-0');
      tokens.destroy();
    }
  });

  it('keeps the session on a network error', async () => {
    const tokens = new TokenManager(new MemoryStorageAdapter(), 'of_');
    tokens.setTokens(jwt(30), 'refresh-0', user);
    const outcome = await coordinatedRefresh({ tokens, doFetch: async () => { throw new TypeError('fetch failed'); }, lock: sharedLock() });
    expect(outcome).toBe('retry-later');
    expect(tokens.getRefreshJwt()).toBe('refresh-0');
    tokens.destroy();
  });

  it('signs out when the server says the refresh token is no good', async () => {
    for (const status of [400, 401, 403, 410]) {
      const tokens = new TokenManager(new MemoryStorageAdapter(), 'of_');
      tokens.setTokens(jwt(30), 'refresh-0', user);
      const outcome = await coordinatedRefresh({ tokens, doFetch: async () => new Response('{}', { status }), lock: sharedLock() });
      expect(outcome, String(status)).toBe('signed-out');
      expect(tokens.getRefreshJwt(), String(status)).toBeNull();
      tokens.destroy();
    }
  });
});
