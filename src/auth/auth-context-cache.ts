/**
 * In-process cache for the AuthContext synthesised from a DID for OAuth
 * and service-auth requests.
 *
 * Local Bearer JWT auth doesn't pay this cost — the JWT payload IS the
 * AuthContext. But OAuth (DPoP) and service-auth (cross-PDS federation)
 * require resolving DID → user record → roles, which is two sequential
 * SQL queries on every request. For SDK clients firing 4-6 requests per
 * page, that's 8-12 round-trips of overhead.
 *
 * The TTL is intentionally short (60s) — much shorter than the local
 * Bearer access-token lifetime — so the security model around suspends/
 * status changes isn't weakened. A user suspended right now still gets
 * up to 60s of grace under cached auth, but a local Bearer JWT user
 * gets up to ~15 minutes of grace until their access token expires, so
 * the cache window is the tighter bound.
 *
 * Cache size is bounded by simple eviction when the limit is hit; the
 * Map iteration order gives us oldest-insert-first ≈ LRU enough.
 */

import type { AuthContext } from './types.js';

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 5_000;

type CacheKey = string; // `${authMethod}:${did}` — separate caches by auth method

interface Entry {
  context: AuthContext;
  expiresAt: number;
}

const cache = new Map<CacheKey, Entry>();

function key(authMethod: string, did: string): CacheKey {
  return `${authMethod}:${did}`;
}

export function getCachedAuthContext(
  authMethod: 'oauth' | 'service-auth',
  did: string,
): AuthContext | null {
  const entry = cache.get(key(authMethod, did));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key(authMethod, did));
    return null;
  }
  return entry.context;
}

export function setCachedAuthContext(
  authMethod: 'oauth' | 'service-auth',
  did: string,
  context: AuthContext,
): void {
  if (cache.size >= MAX_ENTRIES) {
    // Evict the oldest insertion. Map iteration is insertion order, so
    // the first key in the iterator is the oldest.
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key(authMethod, did), { context, expiresAt: Date.now() + TTL_MS });
}

/**
 * Drop all cached AuthContext entries for a DID. Call from endpoints
 * that change user status or roles (admin.updateSubjectStatus,
 * account.updateRoles, account.deleteAccount, etc.) so changes take
 * effect immediately rather than waiting for the TTL.
 */
export function invalidateAuthContext(did: string): void {
  cache.delete(key('oauth', did));
  cache.delete(key('service-auth', did));
}

/** Test helper — not exported via index. */
export function _clearAuthContextCache(): void {
  cache.clear();
}
