import type { TokenManager } from './auth.js';
import type { User } from './types.js';

export type RefreshOutcome =
  /** This call exchanged the refresh token for a new pair. */
  | 'refreshed'
  /** Another tab had already refreshed; its tokens were taken from shared storage. */
  | 'adopted'
  /** The server refused the refresh token, or there was none: the session is over. */
  | 'signed-out'
  /** The server or the network failed; the session is kept and the refresh should be tried again. */
  | 'retry-later';

export type RefreshLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

interface RefreshResponseBody {
  did: string;
  handle: string;
  email: string;
  active?: boolean;
  accessJwt: string;
  refreshJwt: string;
}

/**
 * The lock browsers give tabs of one origin (`navigator.locks`). Where it is
 * missing (older browsers, non-browser runtimes) calls run unserialised, which
 * is what happened before; the server's short grace window for a just-rotated
 * token covers the overlap.
 */
export function defaultRefreshLock(): RefreshLock {
  const locks = (globalThis as { navigator?: { locks?: { request: <T>(name: string, fn: () => Promise<T>) => Promise<T> } } })
    .navigator?.locks;
  if (locks && typeof locks.request === 'function') {
    return (name, fn) => locks.request(name, fn);
  }
  return (_name, fn) => fn();
}

/**
 * Refresh the session, safely across tabs and across failures.
 *
 * Tokens live in storage that every tab of the app shares, and each tab runs
 * its own timer, so they all decide to refresh at the same moment with the
 * same refresh token. The server rotates that token on use. Taking turns under
 * a cross-tab lock, each tab first looks at storage again: if the refresh token
 * there is no longer the one it set out with, another tab has done the work and
 * this one simply adopts the result.
 *
 * Only a definitive answer ends the session. "Too many requests", a server
 * error or a dropped connection says nothing about the refresh token, and
 * clearing the tokens on those turned a blip into a logout.
 */
export async function coordinatedRefresh(deps: {
  tokens: Pick<TokenManager, 'getRefreshJwt' | 'setTokens' | 'clear' | 'rescheduleFromStorage'>;
  doFetch: (refreshJwt: string) => Promise<Response>;
  lock?: RefreshLock;
  lockName?: string;
  /** Completes a short handle from an older server with its domain (#411). */
  completeHandle?: (handle: string) => Promise<string>;
}): Promise<RefreshOutcome> {
  const { tokens, doFetch } = deps;
  const lock = deps.lock ?? defaultRefreshLock();
  const startedWith = tokens.getRefreshJwt();
  if (!startedWith) {
    tokens.clear();
    return 'signed-out';
  }

  return lock(deps.lockName ?? 'openfederation-sdk-refresh', async (): Promise<RefreshOutcome> => {
    const current = tokens.getRefreshJwt();
    if (!current) {
      // Another tab signed out while this one waited.
      tokens.clear();
      return 'signed-out';
    }
    if (current !== startedWith) {
      tokens.rescheduleFromStorage();
      return 'adopted';
    }

    let res: Response;
    try {
      res = await doFetch(current);
    } catch {
      return 'retry-later';
    }

    if (res.ok) {
      const data = (await res.json()) as RefreshResponseBody;
      const handle = deps.completeHandle ? await deps.completeHandle(data.handle) : data.handle;
      const user: User = { did: data.did, handle, email: data.email, active: data.active ?? true };
      tokens.setTokens(data.accessJwt, data.refreshJwt, user);
      return 'refreshed';
    }

    // 400/401/403/410: the server looked at the token and said no.
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 410) {
      tokens.clear();
      return 'signed-out';
    }
    // 429, 5xx, anything else: not a verdict on the token.
    return 'retry-later';
  });
}
