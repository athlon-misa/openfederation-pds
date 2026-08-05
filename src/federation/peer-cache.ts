import { config } from '../config.js';
import { isPrivateHost } from './remote-verify.js';
import { assertPublicHttpsUrl, readLimitedText } from '../security/outbound-fetch.js';

export const MAX_PEER_RESPONSE_BYTES = 256 * 1024;
export const MAX_COMMUNITIES_PER_PEER = 100;
export const MAX_CACHED_COMMUNITIES = 500;

/** Fetch JSON from a peer only after validating its destination and response size. */
export async function fetchPeerJson(url: string, signal: AbortSignal): Promise<unknown | null> {
  const safeUrl = await assertPublicHttpsUrl(url);
  const response = await fetch(safeUrl, { signal, redirect: 'error' });
  if (!response.ok) return null;
  return JSON.parse(await readLimitedText(response, MAX_PEER_RESPONSE_BYTES));
}

/**
 * In-memory TTL cache for peer PDS data.
 * Follows the pattern from src/auth/partner-guard.ts (getCachedPartnerOrigins).
 *
 * Includes in-flight-promise deduplication: when the TTL expires, concurrent
 * callers share a single outbound fan-out instead of each triggering their
 * own Promise.allSettled to every peer. Prevents cache-stampede spikes on
 * high-traffic federation endpoints.
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
let inFlightCommunities: Promise<{ communities: PeerCommunity[]; cachedAt: number }> | null = null;

/**
 * Fetch public communities from all configured peer PDS servers.
 * Results are cached for the configured TTL (default 5 min). Concurrent
 * callers on an expired cache share the same refresh promise.
 */
export async function getCachedPeerCommunities(): Promise<{ communities: PeerCommunity[]; cachedAt: number }> {
  if (Date.now() - communitiesCachedAt < config.federation.cacheTtlMs) {
    return { communities: cachedCommunities, cachedAt: communitiesCachedAt };
  }
  if (inFlightCommunities) return inFlightCommunities;

  inFlightCommunities = (async () => {
    try {
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
            const url = new URL('/xrpc/net.openfederation.community.listAll?limit=100&visibility=public', peerUrl);
            const data = await fetchPeerJson(url.toString(), controller.signal) as { communities?: unknown } | null;
            if (!data || !Array.isArray(data.communities)) return [];

            let peerHostname: string;
            try {
              peerHostname = new URL(peerUrl).hostname;
            } catch {
              peerHostname = peerUrl;
            }

            const webUrl = peerWebUrls.get(peerUrl) || null;

            return data.communities.slice(0, MAX_COMMUNITIES_PER_PEER).map((c: any): PeerCommunity => ({
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
          for (const community of result.value) {
            if (communities.length >= MAX_CACHED_COMMUNITIES) break;
            communities.push(community);
          }
        }
        if (communities.length >= MAX_CACHED_COMMUNITIES) break;
      }

      cachedCommunities = communities;
      communitiesCachedAt = Date.now();
      return { communities: cachedCommunities, cachedAt: communitiesCachedAt };
    } finally {
      inFlightCommunities = null;
    }
  })();

  return inFlightCommunities;
}

// --- Peer info cache ---

let cachedPeerInfo: PeerInfo[] = [];
let peerInfoCachedAt = 0;
let inFlightPeerInfo: Promise<PeerInfo[]> | null = null;

/**
 * Fetch public config/health from all configured peer PDS servers.
 * Results are cached for the configured TTL (default 5 min). Concurrent
 * callers on an expired cache share the same refresh promise.
 */
export async function getCachedPeerInfo(): Promise<PeerInfo[]> {
  if (Date.now() - peerInfoCachedAt < config.federation.cacheTtlMs) {
    return cachedPeerInfo;
  }
  if (inFlightPeerInfo) return inFlightPeerInfo;

  inFlightPeerInfo = (async () => {
    try {
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

          if (isPrivateHost(peerHostname)) {
            console.warn(`Skipping peer ${peerUrl}: private/internal host`);
            return { hostname: peerHostname, serviceUrl: peerUrl, webUrl: null, healthy: false };
          }

          try {
            const url = new URL('/xrpc/net.openfederation.server.getPublicConfig', peerUrl);
            const data = await fetchPeerJson(url.toString(), controller.signal) as {
              hostname?: string;
              serviceUrl?: string;
              webUrl?: string | null;
              stats?: { activeCommunities?: number };
            } | null;
            if (!data) {
              return { hostname: peerHostname, serviceUrl: peerUrl, webUrl: null, healthy: false };
            }

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
    } finally {
      inFlightPeerInfo = null;
    }
  })();

  return inFlightPeerInfo;
}
