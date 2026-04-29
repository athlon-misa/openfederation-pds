import dns from 'dns/promises';

const CACHE = new Map<string, { did: string; expiresAt: number }>();
const TTL_MS = 60 * 60 * 1000; // 1 hour
const TIMEOUT_MS = 3000;

function cached(handle: string): string | null {
  const entry = CACHE.get(handle);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { CACHE.delete(handle); return null; }
  return entry.did;
}

function cache(handle: string, did: string): void {
  CACHE.set(handle, { did, expiresAt: Date.now() + TTL_MS });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
  ]);
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

async function tryWellKnown(handle: string): Promise<string | null> {
  try {
    const url = `https://${handle}/.well-known/atproto-did`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return text.startsWith('did:') ? text : null;
    } finally {
      clearTimeout(timer);
    }
  } catch { /* network error */ }
  return null;
}

/**
 * Resolve a handle that isn't local to this PDS.
 * Tries DNS TXT first (faster, no HTTP), then HTTPS well-known.
 * Results are cached for 1 hour.
 */
export async function resolveExternalHandle(handle: string): Promise<string | null> {
  const hit = cached(handle);
  if (hit) return hit;

  // Skip obviously local-looking handles (no dot = bare handle, not a domain)
  if (!handle.includes('.')) return null;

  const did = await withTimeout(
    (async () => {
      const fromDns = await tryDnsTxt(handle);
      if (fromDns) return fromDns;
      return tryWellKnown(handle);
    })(),
    TIMEOUT_MS,
  );

  if (did) cache(handle, did);
  return did;
}
