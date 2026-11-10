import dns from 'dns/promises';
import { assertPublicHttpsUrl, readLimitedText } from '../security/outbound-fetch.js';

type CacheEntry =
  | { kind: 'hit'; did: string; expiresAt: number }
  | { kind: 'miss'; expiresAt: number };

const CACHE = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 1000;
const TTL_HIT_MS = 60 * 60 * 1000;       // 1 hour for successful resolutions
const TTL_MISS_MS = 60 * 1000;           // 1 minute for failures — short enough
                                         // that legitimate fixes propagate fast,
                                         // long enough to absorb retry storms
                                         // from typo'd handles
const TIMEOUT_MS = 2000;                 // overall cap; well-known is the slow leg
const MAX_WELL_KNOWN_BYTES = 8 * 1024;

function cached(handle: string): { hit: true; did: string | null } | { hit: false } {
  const entry = CACHE.get(handle);
  if (!entry) return { hit: false };
  if (Date.now() > entry.expiresAt) {
    CACHE.delete(handle);
    return { hit: false };
  }
  return { hit: true, did: entry.kind === 'hit' ? entry.did : null };
}

function cacheHit(handle: string, did: string): void {
  evictCacheEntries(handle);
  CACHE.set(handle, { kind: 'hit', did, expiresAt: Date.now() + TTL_HIT_MS });
}

function cacheMiss(handle: string): void {
  evictCacheEntries(handle);
  CACHE.set(handle, { kind: 'miss', expiresAt: Date.now() + TTL_MISS_MS });
}

function evictCacheEntries(incomingHandle: string): void {
  const now = Date.now();
  for (const [handle, entry] of CACHE) {
    if (entry.expiresAt <= now) CACHE.delete(handle);
  }
  while (CACHE.size >= MAX_CACHE_ENTRIES && !CACHE.has(incomingHandle)) {
    const oldest = CACHE.keys().next().value as string | undefined;
    if (!oldest) break;
    CACHE.delete(oldest);
  }
}

/** Test-only cache controls. */
export function _clearExternalHandleCache(): void { CACHE.clear(); }
export function _externalHandleCacheSize(): number { return CACHE.size; }
export function _cacheExternalHandleMissForTest(handle: string): void { cacheMiss(handle); }

async function tryDnsTxt(handle: string): Promise<string | null> {
  try {
    const records = await dns.resolveTxt(`_atproto.${handle}`);
    for (const chunks of records) {
      const txt = chunks.join('');
      const match = txt.match(/^did=(.+)$/);
      if (match?.[1]?.startsWith('did:')) return match[1];
    }
  } catch { /* NXDOMAIN or timeout */ }
  return null;
}

/**
 * Whether `handle` is a plain domain name: dot-separated labels of letters,
 * digits and hyphens, with a non-numeric last label. The handle is placed
 * straight into a URL and fetched, so anything else is refused here: a port,
 * a path, credentials, or an IP address would turn handle resolution into a
 * way to make this server call hosts of the caller's choosing.
 */
export function isDomainHandle(handle: string): boolean {
  if (handle.length > 253) return false;
  const labels = handle.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

async function tryWellKnown(handle: string, signal: AbortSignal): Promise<string | null> {
  try {
    // Must resolve to public addresses only, and is not allowed to redirect:
    // a redirect could point anywhere, including at internal services.
    const url = await assertPublicHttpsUrl(`https://${handle}/.well-known/atproto-did`);
    const res = await fetch(url, { signal, redirect: 'error' });
    if (!res.ok) return null;
    const text = (await readLimitedText(res, MAX_WELL_KNOWN_BYTES)).trim();
    return text.startsWith('did:') ? text : null;
  } catch { /* network error or abort */ }
  return null;
}

/**
 * Resolve a handle that isn't local to this PDS.
 *
 * Both legs (DNS TXT + HTTPS well-known) race in parallel; the first
 * non-null answer wins, the loser is aborted. Total latency is bounded
 * by `TIMEOUT_MS` (2s) and in practice settles well under that — DNS
 * usually answers in <100ms when the record exists.
 *
 * Successful resolutions are cached for 1 hour. Failures are cached for
 * 1 minute so a typo or down host doesn't force every subsequent retry
 * to wait the full timeout.
 */
export async function resolveExternalHandle(handle: string): Promise<string | null> {
  const hit = cached(handle);
  if (hit.hit) return hit.did;

  // Only real domain names are resolved (which also skips bare local handles).
  if (!isDomainHandle(handle)) return null;

  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // Race DNS and well-known. The first non-null wins.
    const did = await new Promise<string | null>((resolve) => {
      let pending = 2;
      const settle = (value: string | null) => {
        if (value) {
          resolve(value);
          return;
        }
        if (--pending === 0) resolve(null);
      };
      tryDnsTxt(handle).then(settle, () => settle(null));
      tryWellKnown(handle, controller.signal).then(settle, () => settle(null));
    });

    if (did) {
      cacheHit(handle, did);
    } else {
      cacheMiss(handle);
    }
    return did;
  } finally {
    clearTimeout(overallTimer);
    controller.abort();
  }
}
