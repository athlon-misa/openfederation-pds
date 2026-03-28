import { config } from '../config.js';

interface RemoteRecord {
  uri: string;
  cid: string;
  value: any;
}

interface CacheEntry {
  result: RemoteRecord | null;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(key: string): RemoteRecord | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.result;
}

function setCache(key: string, result: RemoteRecord | null): void {
  cache.set(key, { result, timestamp: Date.now() });
}

export async function resolveDidToPds(did: string): Promise<string | null> {
  try {
    let didDoc: any;

    if (did.startsWith('did:plc:')) {
      const plcUrl = config.plc.directoryUrl;
      const resp = await fetch(`${plcUrl}/${did}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;
      didDoc = await resp.json();
    } else if (did.startsWith('did:web:')) {
      const domain = did.replace('did:web:', '');
      const resp = await fetch(`https://${domain}/.well-known/did.json`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;
      didDoc = await resp.json();
    } else {
      return null;
    }

    const services = didDoc.service || [];
    const pdsService = services.find(
      (s: any) => s.type === 'AtprotoPersonalDataServer' || s.id === '#atproto_pds'
    );
    return pdsService?.serviceEndpoint || null;
  } catch {
    return null;
  }
}

export async function fetchRemoteRecord(
  pdsUrl: string,
  did: string,
  collection: string,
  rkey: string,
): Promise<RemoteRecord | null> {
  const cacheKey = `${pdsUrl}:${did}:${collection}:${rkey}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const url = new URL('/xrpc/com.atproto.repo.getRecord', pdsUrl);
    url.searchParams.set('repo', did);
    url.searchParams.set('collection', collection);
    url.searchParams.set('rkey', rkey);

    const resp = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      setCache(cacheKey, null);
      return null;
    }

    const data = await resp.json() as RemoteRecord;
    setCache(cacheKey, data);
    return data;
  } catch {
    setCache(cacheKey, null);
    return null;
  }
}
