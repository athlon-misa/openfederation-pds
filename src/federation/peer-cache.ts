import { config } from '../config.js';

/**
 * In-memory TTL cache for peer PDS data.
 * Follows the pattern from src/auth/partner-guard.ts (getCachedPartnerOrigins).
 */

// --- Types ---

export interface PeerInfo {
  hostname: string;
  serviceUrl: string;
  webUrl: string | null;
  healthy: boolean;
  activeCommunities?: number;
}

export interface PeerCommunity {
  did: string;
  handle: string;
  didMethod: 'plc' | 'web';
  displayName: string;
  description: string;
  visibility: 'public' | 'private';
  joinPolicy: 'open' | 'approval';
  memberCount: number;
  createdAt: string;
  pdsUrl: string;
  pdsHostname: string;
  webUrl: string | null;
}

// --- Peer communities cache ---

let cachedCommunities: PeerCommunity[] = [];
let communitiesCachedAt = 0;

/**
 * Fetch public communities from all configured peer PDS servers.
 * Results are cached for the configured TTL (default 5 min).
 */
export async function getCachedPeerCommunities(): Promise<{ communities: PeerCommunity[]; cachedAt: number }> {
  if (Date.now() - communitiesCachedAt < config.federation.cacheTtlMs) {
    return { communities: cachedCommunities, cachedAt: communitiesCachedAt };
  }

  const peerUrls = config.federation.peerUrls;
  if (peerUrls.length === 0) {
    cachedCommunities = [];
    communitiesCachedAt = Date.now();
    return { communities: cachedCommunities, cachedAt: communitiesCachedAt };
  }

  // First fetch peer info to get webUrl for each peer
  const peerInfo = await getCachedPeerInfo();
  const peerWebUrls = new Map<string, string | null>();
  for (const p of peerInfo) {
    peerWebUrls.set(p.serviceUrl, p.webUrl);
  }

  const results = await Promise.allSettled(
    peerUrls.map(async (peerUrl) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const url = `${peerUrl}/xrpc/net.openfederation.community.listAll?limit=100&visibility=public`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return [];

        const data = await response.json() as { communities?: any[] };
        if (!Array.isArray(data.communities)) return [];

        let peerHostname: string;
        try {
          peerHostname = new URL(peerUrl).hostname;
        } catch {
          peerHostname = peerUrl;
        }

        const webUrl = peerWebUrls.get(peerUrl) || null;

        return data.communities.map((c: any): PeerCommunity => ({
          did: c.did,
          handle: c.handle,
          didMethod: c.didMethod,
          displayName: c.displayName || c.handle,
          description: c.description || '',
          visibility: c.visibility || 'public',
          joinPolicy: c.joinPolicy || 'open',
          memberCount: c.memberCount || 0,
          createdAt: c.createdAt,
          pdsUrl: peerUrl,
          pdsHostname: peerHostname,
          webUrl,
        }));
      } finally {
        clearTimeout(timeout);
      }
    })
  );

  const communities: PeerCommunity[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      communities.push(...result.value);
    }
  }

  cachedCommunities = communities;
  communitiesCachedAt = Date.now();
  return { communities: cachedCommunities, cachedAt: communitiesCachedAt };
}

// --- Peer info cache ---

let cachedPeerInfo: PeerInfo[] = [];
let peerInfoCachedAt = 0;

/**
 * Fetch public config/health from all configured peer PDS servers.
 * Results are cached for the configured TTL (default 5 min).
 */
export async function getCachedPeerInfo(): Promise<PeerInfo[]> {
  if (Date.now() - peerInfoCachedAt < config.federation.cacheTtlMs) {
    return cachedPeerInfo;
  }

  const peerUrls = config.federation.peerUrls;
  if (peerUrls.length === 0) {
    cachedPeerInfo = [];
    peerInfoCachedAt = Date.now();
    return cachedPeerInfo;
  }

  const results = await Promise.allSettled(
    peerUrls.map(async (peerUrl): Promise<PeerInfo> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      let peerHostname: string;
      try {
        peerHostname = new URL(peerUrl).hostname;
      } catch {
        peerHostname = peerUrl;
      }

      try {
        const url = `${peerUrl}/xrpc/net.openfederation.server.getPublicConfig`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          return { hostname: peerHostname, serviceUrl: peerUrl, webUrl: null, healthy: false };
        }

        const data = await response.json() as {
          hostname?: string;
          serviceUrl?: string;
          webUrl?: string | null;
          stats?: { activeCommunities?: number };
        };

        return {
          hostname: data.hostname || peerHostname,
          serviceUrl: data.serviceUrl || peerUrl,
          webUrl: data.webUrl || null,
          healthy: true,
          activeCommunities: data.stats?.activeCommunities,
        };
      } catch {
        return { hostname: peerHostname, serviceUrl: peerUrl, webUrl: null, healthy: false };
      } finally {
        clearTimeout(timeout);
      }
    })
  );

  cachedPeerInfo = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { hostname: 'unknown', serviceUrl: 'unknown', webUrl: null, healthy: false }
  );
  peerInfoCachedAt = Date.now();
  return cachedPeerInfo;
}
