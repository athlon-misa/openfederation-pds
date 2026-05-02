import dns from 'dns/promises';

type CacheEntry =
  | { kind: 'hit'; did: string; expiresAt: number }
  | { kind: 'miss'; expiresAt: number };

const CACHE = new Map<string, CacheEntry>();
const TTL_HIT_MS = 60 * 60 * 1000;       // 1 hour for successful resolutions
const TTL_MISS_MS = 60 * 1000;           // 1 minute for failures — short enough
                                         // that legitimate fixes propagate fast,
                                         // long enough to absorb retry storms
                                         // from typo'd handles
const TIMEOUT_MS = 2000;                 // overall cap; well-known is the slow leg

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
  CACHE.set(handle, { kind: 'hit', did, expiresAt: Date.now() + TTL_HIT_MS });
}

function cacheMiss(handle: string): void {
  CACHE.set(handle, { kind: 'miss', expiresAt: Date.now() + TTL_MISS_MS });
}

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

async function tryWellKnown(handle: string, signal: AbortSignal): Promise<string | null> {
  try {
    const url = `https://${handle}/.well-known/atproto-did`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
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

  // Skip obviously local-looking handles (no dot = bare handle, not a domain)
  if (!handle.includes('.')) return null;

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
