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

/**
 * Returns true if the hostname/IP resolves to a private, loopback, or link-local
 * address that must not be fetched as part of federation (SSRF guard).
 */
function isPrivateHost(hostname: string): boolean {
  // Strip brackets from IPv6 addresses (e.g., [::1] → ::1)
  const lc = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Reject localhost variants
  if (lc === 'localhost' || lc.endsWith('.localhost')) return true;

  // Reject IPv6 loopback and unspecified addresses
  if (lc === '::1' || lc === '0:0:0:0:0:0:0:1' || lc === '::' || lc === '0:0:0:0:0:0:0:0') return true;

  // Reject IPv6 link-local (fe80::/10) and unique-local (fc00::/7, fd00::/8)
  // Strip leading segments including compressed notation
  if (/^fe[89ab][0-9a-f]/i.test(lc) || /^fc[0-9a-f]{2}/i.test(lc) || /^fd[0-9a-f]{2}/i.test(lc)) return true;

  // Reject IPv4-mapped IPv6 addresses (::ffff:w.x.y.z)
  const ipv4MappedMatch = /^(?:::ffff:)((?:\d{1,3}\.){3}\d{1,3})$/i.exec(lc);
  const ipv4Candidate = ipv4MappedMatch ? ipv4MappedMatch[1] : lc;

  // Validate and check IPv4 addresses (strict octet range 0-255)
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4Candidate);
  if (ipv4Match) {
    const octets = [ipv4Match[1], ipv4Match[2], ipv4Match[3], ipv4Match[4]].map(Number);
    if (octets.some(o => o > 255)) return false; // malformed — not a valid IP; don't block
    const [a, b, c, d] = octets;
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 10) return true;                          // 10.0.0.0/8 private
    if (a === 127) return true;                         // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 private
    if (a === 192 && b === 0 && c === 0) return true;  // 192.0.0.0/24 IETF
    if (a === 192 && b === 0 && c === 2) return true;  // 192.0.2.0/24 TEST-NET-1
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16 private
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 shared
    if (a >= 224) return true;                          // 224+: multicast, reserved, broadcast
    return false;
  }

  return false;
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
      // SSRF guard: reject private/internal addresses before making the request
      if (isPrivateHost(domain)) return null;
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
