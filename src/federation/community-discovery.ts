/**
 * Cross-server community discovery (#41): peer list + well-known.
 *
 * Every OpenFederation PDS publishes its own public communities at
 * WELL_KNOWN_COMMUNITIES_PATH. `net.openfederation.community.discover` merges
 * this server's list with the same document fetched from each peer named by a
 * PeerSource (today: FEDERATION_PEERS). There is no central service and no
 * gossip: a peer's list is never re-published here.
 *
 * Privacy (#85, ADR-001): the local list uses the same public-only filter as
 * `community.listAll`. What peers send is untrusted: the shape is validated
 * entry by entry, anything a peer marks as not public is dropped, and a peer
 * can never speak for a DID this server hosts — so a peer cannot surface a
 * private community of ours, or rename a public one.
 */
import { config } from '../config.js';
import { query } from '../db/client.js';
import { assertPublicHttpsUrl, OutboundFetchError, readLimitedText } from '../security/outbound-fetch.js';
import { resolvePeerUrls, staticPeerSource, type PeerSource } from './peer-sources.js';
import { cleanText, isPeerDid, isPeerHandle } from './peer-data.js';

export const WELL_KNOWN_COMMUNITIES_PATH = '/.well-known/openfederation-communities.json';
export const DIRECTORY_VERSION = 1;

/** Most communities this server lists in its own document. */
export const MAX_LOCAL_ENTRIES = 1000;
/** Most entries kept from one peer. */
export const MAX_ENTRIES_PER_PEER = 1000;
/** Largest peer document read; anything bigger fails that peer. */
export const MAX_PEER_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_DISPLAY_NAME_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 300;
/** A failed peer is retried after this long at most, even with a long TTL. */
const FAILURE_TTL_MS = 30_000;

export interface DirectoryEntry {
  did: string;
  handle: string;
  displayName: string;
  description: string;
  memberCount: number;
  /** Base URL of the PDS that hosts the community. */
  pdsUrl: string;
}

export interface CommunityDirectory {
  version: number;
  pds: { url: string; hostname: string };
  generatedAt: string;
  communities: DirectoryEntry[];
}

export type PeerError = 'Timeout' | 'Unreachable' | 'BlockedUrl' | 'HttpError' | 'InvalidResponse' | 'ResponseTooLarge';

export type PeerResult =
  | { url: string; status: 'ok'; communities: DirectoryEntry[] }
  | { url: string; status: 'failed'; error: PeerError };

// ── Local document ──────────────────────────────────────────────

/** Active, public communities hosted here, newest first. Same filter as listAll. */
export async function listLocalDirectoryEntries(): Promise<DirectoryEntry[]> {
  const result = await query<{
    did: string;
    handle: string;
    profile: { displayName?: unknown; description?: unknown } | null;
    member_count: number;
  }>(
    `SELECT c.did, c.handle, p.record AS profile,
            COALESCE(mc.member_count, 0) AS member_count
     FROM communities c
     LEFT JOIN records_index s ON s.community_did = c.did
       AND s.collection = 'net.openfederation.community.settings' AND s.rkey = 'self'
     LEFT JOIN records_index p ON p.community_did = c.did
       AND p.collection = 'net.openfederation.community.profile' AND p.rkey = 'self'
     LEFT JOIN (
       SELECT community_did, COUNT(*)::int AS member_count
       FROM members_unique GROUP BY community_did
     ) mc ON mc.community_did = c.did
     WHERE c.status = 'active'
       AND COALESCE(s.record->>'visibility', 'public') = 'public'
     ORDER BY c.created_at DESC
     LIMIT $1`,
    [MAX_LOCAL_ENTRIES],
  );
  const pdsUrl = config.pds.serviceUrl;
  return result.rows.map((row) => ({
    did: row.did,
    handle: row.handle,
    displayName: cleanText(row.profile?.displayName, MAX_DISPLAY_NAME_LENGTH) || row.handle,
    description: cleanText(row.profile?.description, MAX_DESCRIPTION_LENGTH),
    memberCount: row.member_count,
    pdsUrl,
  }));
}

export async function buildLocalDirectory(): Promise<CommunityDirectory> {
  return {
    version: DIRECTORY_VERSION,
    pds: { url: config.pds.serviceUrl, hostname: config.pds.hostname },
    generatedAt: new Date().toISOString(),
    communities: await listLocalDirectoryEntries(),
  };
}

// ── Peer documents (untrusted) ──────────────────────────────────

/**
 * Validate a peer's document. Throws when the document as a whole is not a
 * directory; drops entries that are malformed or that the peer marks as not
 * public. `pdsUrl` is always the peer we fetched from, whatever it claims.
 */
export function parsePeerDirectory(data: unknown, peerUrl: string): DirectoryEntry[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
  const doc = data as { version?: unknown; communities?: unknown };
  if (typeof doc.version !== 'number' || !Number.isInteger(doc.version) || doc.version < 1) {
    throw new Error('missing version');
  }
  if (!Array.isArray(doc.communities)) throw new Error('missing communities');

  const out: DirectoryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of doc.communities) {
    if (out.length >= MAX_ENTRIES_PER_PEER) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    if (!isPeerDid(e.did) || !isPeerHandle(e.handle)) continue;
    if (e.visibility !== undefined && e.visibility !== 'public') continue;
    let memberCount = 0;
    if (e.memberCount !== undefined) {
      if (typeof e.memberCount !== 'number' || !Number.isInteger(e.memberCount) || e.memberCount < 0) continue;
      memberCount = Math.min(e.memberCount, 1_000_000_000);
    }
    if (seen.has(e.did)) continue;
    seen.add(e.did);
    out.push({
      did: e.did,
      handle: e.handle,
      displayName: cleanText(e.displayName, MAX_DISPLAY_NAME_LENGTH) || e.handle,
      description: cleanText(e.description, MAX_DESCRIPTION_LENGTH),
      memberCount,
      pdsUrl: peerUrl,
    });
  }
  return out;
}

/** Destination check: public HTTPS only in production; dev and test may use local http peers. */
async function checkPeerUrl(url: string): Promise<URL> {
  if (config.env.isProduction) return assertPublicHttpsUrl(url);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OutboundFetchError('Outbound URL must use HTTP(S)');
  }
  return parsed;
}

class PeerFailure extends Error {
  constructor(readonly code: PeerError) { super(code); }
}

/** Fetch one peer's document. Never throws: a failure is a result. */
export async function fetchPeerDirectory(peerUrl: string, timeoutMs = config.federation.peerTimeoutMs): Promise<PeerResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PeerFailure('Timeout'));
    }, timeoutMs);
  });

  const attempt = (async (): Promise<DirectoryEntry[]> => {
    let target: URL;
    try {
      target = await checkPeerUrl(new URL(WELL_KNOWN_COMMUNITIES_PATH, peerUrl).toString());
    } catch {
      throw new PeerFailure('BlockedUrl');
    }
    let response: Response;
    try {
      response = await fetch(target, {
        signal: controller.signal,
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new PeerFailure(controller.signal.aborted ? 'Timeout' : 'Unreachable');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new PeerFailure('HttpError');
    }
    let text: string;
    try {
      text = await readLimitedText(response, MAX_PEER_DOCUMENT_BYTES);
    } catch (err) {
      if (controller.signal.aborted) throw new PeerFailure('Timeout');
      throw new PeerFailure(err instanceof OutboundFetchError ? 'ResponseTooLarge' : 'Unreachable');
    }
    try {
      return parsePeerDirectory(JSON.parse(text), peerUrl);
    } catch {
      throw new PeerFailure('InvalidResponse');
    }
  })();
  attempt.catch(() => {}); // the timeout may win; don't leave a rejection unhandled

  try {
    const communities = await Promise.race([attempt, timeout]);
    return { url: peerUrl, status: 'ok', communities };
  } catch (err) {
    return { url: peerUrl, status: 'failed', error: err instanceof PeerFailure ? err.code : 'Unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-peer cache ──────────────────────────────────────────────

const cache = new Map<string, { result: PeerResult; at: number }>();
const inFlight = new Map<string, Promise<PeerResult>>();

/** Test-only. */
export function _clearDiscoveryCache(): void {
  cache.clear();
  inFlight.clear();
}

/** One peer's document, from cache when fresh; concurrent callers share one fetch. */
export async function getPeerDirectory(peerUrl: string): Promise<PeerResult> {
  const hit = cache.get(peerUrl);
  if (hit) {
    const ttl = hit.result.status === 'ok'
      ? config.federation.cacheTtlMs
      : Math.min(config.federation.cacheTtlMs, FAILURE_TTL_MS);
    if (Date.now() - hit.at < ttl) return hit.result;
  }
  const pending = inFlight.get(peerUrl);
  if (pending) return pending;

  const request = fetchPeerDirectory(peerUrl).then((result) => {
    cache.set(peerUrl, { result, at: Date.now() });
    return result;
  }).finally(() => inFlight.delete(peerUrl));
  inFlight.set(peerUrl, request);
  return request;
}

// ── Peer sources ────────────────────────────────────────────────

/** FEDERATION_PEERS (and the older PEER_PDS_URLS); nothing when FEDERATION_PEERS_ENABLED=false. */
const configuredPeers = staticPeerSource('FEDERATION_PEERS', () =>
  config.federation.enabled ? config.federation.peerUrls : []);

/** Every place peers come from. A central directory would be added here. */
export function peerSources(): PeerSource[] {
  return [configuredPeers];
}

// ── Merge ───────────────────────────────────────────────────────

export interface DiscoveredCommunity extends DirectoryEntry {
  source: 'local' | 'peer';
}

export interface DiscoveryResult {
  communities: DiscoveredCommunity[];
  peers: Array<{ url: string; status: 'ok'; communityCount: number } | { url: string; status: 'failed'; error: PeerError }>;
}

/**
 * This server's communities followed by each peer's, in peer order,
 * deduplicated by DID (first wins). Peer entries for any DID this server
 * hosts — public, private, suspended — are dropped: only this server speaks
 * for its own communities.
 */
export async function discoverCommunities(): Promise<DiscoveryResult> {
  const peerUrls = await resolvePeerUrls(peerSources(), config.pds.serviceUrl);
  // Forget peers no source names any more, so the cache stays as big as the peer list.
  for (const url of cache.keys()) if (!peerUrls.includes(url)) cache.delete(url);
  const [local, results] = await Promise.all([
    listLocalDirectoryEntries(),
    Promise.all(peerUrls.map((url) => getPeerDirectory(url))),
  ]);

  const peerDids = new Set<string>();
  for (const r of results) if (r.status === 'ok') for (const c of r.communities) peerDids.add(c.did);
  const hostedHere = new Set<string>();
  if (peerDids.size > 0) {
    const hosted = await query<{ did: string }>('SELECT did FROM communities WHERE did = ANY($1)', [[...peerDids]]);
    for (const row of hosted.rows) hostedHere.add(row.did);
  }

  const seen = new Set<string>();
  const communities: DiscoveredCommunity[] = [];
  for (const c of local) {
    if (seen.has(c.did)) continue;
    seen.add(c.did);
    communities.push({ ...c, source: 'local' });
  }

  const peers: DiscoveryResult['peers'] = [];
  for (const r of results) {
    if (r.status === 'failed') {
      peers.push({ url: r.url, status: 'failed', error: r.error });
      continue;
    }
    let count = 0;
    for (const c of r.communities) {
      if (hostedHere.has(c.did) || seen.has(c.did)) continue;
      seen.add(c.did);
      communities.push({ ...c, source: 'peer' });
      count++;
    }
    peers.push({ url: r.url, status: 'ok', communityCount: count });
  }
  return { communities, peers };
}
