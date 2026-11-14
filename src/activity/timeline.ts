/**
 * A user's timeline: activity across every community they belong to (#42).
 *
 * Home-PDS fan-out. The caller's own PDS gathers, in parallel:
 *   - communities hosted here: straight from the database, one query for all
 *     of them (src/activity/feed.ts);
 *   - communities elsewhere named by the caller's own membership records
 *     (#385, `net.openfederation.community.membership` in their repo): the
 *     community's PDS is resolved from its DID, then asked which communities
 *     the caller belongs to there (its member records confirm the claim; an
 *     unconfirmed one is a bookmark and is not shown) and for their activity;
 *   - each configured peer PDS, the same way: the fallback for memberships
 *     with no home record (private communities, joins before #385).
 * Remote calls carry service-auth tokens for the caller (src/activity/remote.ts).
 * A server named both ways is asked once.
 * Then it merges by time and pages with a cursor. No push index, no AppView.
 *
 * A peer gets `remoteTimeoutMs` to answer. One that does not is left out of
 * this page and named in the response; the request it was making carries on
 * in the background (up to REMOTE_HARD_TIMEOUT_MS) and fills the cache, so
 * the next call usually has it.
 */
import { config } from '../config.js';
import { runtimeSettings } from '../settings/runtime-settings.js';
import { query } from '../db/client.js';
import type { AuthContext } from '../auth/types.js';
import {
  type ActivityCursor,
  type ActivityEntry,
  encodeActivityCursor,
  loadLocalActivity,
  mergeActivityPage,
  sanitizeRemoteEntry,
  MAX_ACTIVITY_LIMIT,
} from './feed.js';
import { getRemoteActivityClient, MAX_COMMUNITIES_PER_CALL, type RemoteActivityPage } from './remote.js';
import { MEMBERSHIP_COLLECTION } from '../community/membership/home-record.js';
import { resolveDidToPds } from '../federation/remote-verify.js';

/** Communities hosted here that one timeline reads, most recently joined first. */
export const MAX_LOCAL_COMMUNITIES = 100;
/** Communities per peer that one timeline reads (in calls of 25). */
export const MAX_REMOTE_COMMUNITIES_PER_PEER = 100;
/** Home membership records one timeline reads, most recent first (#385). */
export const MAX_HOME_MEMBERSHIPS = 100;
/** Servers, other than configured peers, that home records may send one timeline to. */
export const MAX_HOME_SERVERS = 20;

const DEFAULT_REMOTE_TIMEOUT_MS = 450;
const REMOTE_HARD_TIMEOUT_MS = 5_000;
const REMOTE_FEED_TTL_MS = 10_000;
const MAX_REMOTE_CACHE = 2_000;

let remoteTimeoutMs = DEFAULT_REMOTE_TIMEOUT_MS;

/** Test seam: how long a peer gets before the page is built without it. */
export function _setRemoteTimeoutMs(ms: number | null): void {
  remoteTimeoutMs = ms ?? DEFAULT_REMOTE_TIMEOUT_MS;
}

export interface UserTimeline {
  entries: ActivityEntry[];
  cursor?: string;
  unreachable: string[];
  unreachablePeers: string[];
}

// ── Remote caches (in-flight promises, so concurrent callers share a call) ──

type CacheSlot<T> = { at: number; promise: Promise<T> };
const membershipCache = new Map<string, CacheSlot<string[]>>();
const remoteFeedCache = new Map<string, CacheSlot<RemoteActivityPage>>();
const communityPdsCache = new Map<string, CacheSlot<string | null>>();

function cached<T>(cache: Map<string, CacheSlot<T>>, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const slot = cache.get(key);
  if (slot && Date.now() - slot.at < ttlMs) return slot.promise;
  while (cache.size >= MAX_REMOTE_CACHE) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  const promise = load();
  cache.set(key, { at: Date.now(), promise });
  // A failure is not remembered: the next request tries again.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

/** Test seam: forget remote memberships and feeds. */
export function _clearRemoteActivityCache(): void {
  membershipCache.clear();
  remoteFeedCache.clear();
  communityPdsCache.clear();
}

function withHardTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_HARD_TIMEOUT_MS);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

class DeadlineError extends Error {}

function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = Math.max(deadline - Date.now(), 0);
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError('peer did not answer in time')), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── Building a timeline ──────────────────────────────────────────────────────

type SourceResult = { lists: ActivityEntry[][]; truncated: boolean };

async function localMemberships(viewer: AuthContext): Promise<{ communities: string[]; withJoinRequests: Set<string> }> {
  // Being a member is what makes a community readable to the viewer, private
  // or not. Taken-down, importing and moved copies are not served.
  const memberships = await query<{ did: string; owner_did: string | null }>(
    `SELECT c.did, c.owner_did
       FROM members_unique mu
       JOIN communities c ON c.did = mu.community_did
      WHERE mu.member_did = $1 AND c.status IN ('active', 'suspended')
      ORDER BY mu.created_at DESC
      LIMIT $2`,
    [viewer.did, MAX_LOCAL_COMMUNITIES],
  );
  const isAdmin = viewer.roles.includes('admin');
  return {
    communities: memberships.rows.map((r) => r.did),
    // Join requests: the owner and PDS admins, as listJoinRequests.
    withJoinRequests: new Set(
      memberships.rows.filter((r) => isAdmin || r.owner_did === viewer.did).map((r) => r.did),
    ),
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Communities not hosted here that the viewer's own repo says they belong to
 * (#385): `net.openfederation.community.membership` records, newest first.
 * Claims only; the community's PDS confirms them.
 */
async function homeMembershipClaims(viewerDid: string): Promise<string[]> {
  const rows = await query<{ community: string }>(
    `SELECT ri.record->>'community' AS community
       FROM records_index ri
      WHERE ri.community_did = $1 AND ri.collection = $2
        AND ri.record->>'community' LIKE 'did:%'
        -- Hosted and served here: read from the database. A copy that moved
        -- away is not, so its claim goes to wherever the DID points now.
        AND NOT EXISTS (SELECT 1 FROM communities c
                         WHERE c.did = ri.record->>'community' AND c.status IN ('active', 'suspended'))
      ORDER BY ri.updated_at DESC
      LIMIT $3`,
    [viewerDid, MEMBERSHIP_COLLECTION, MAX_HOME_MEMBERSHIPS],
  );
  return [...new Set(rows.rows.map((r) => r.community))];
}

/**
 * The servers the claimed communities live on, by origin, from their DID
 * documents. A DID that does not resolve in time is left out of this page
 * (and resolved in the background for the next one). Not this server, and at
 * most MAX_HOME_SERVERS of them.
 */
async function homeServers(claims: string[], deadline: number): Promise<Map<string, string[]>> {
  const remote = getRemoteActivityClient();
  const self = originOf(config.pds.serviceUrl);
  const resolved = await Promise.all(claims.map(async (did) => {
    try {
      const pds = await beforeDeadline(
        cached(communityPdsCache, did, config.federation.cacheTtlMs, () => withHardTimeout((signal) =>
          remote.resolveCommunityPds ? remote.resolveCommunityPds(did, signal) : resolveDidToPds(did))),
        deadline,
      );
      return { did, origin: pds ? originOf(pds) : null };
    } catch {
      return { did, origin: null };
    }
  }));
  const servers = new Map<string, string[]>();
  for (const { did, origin } of resolved) {
    if (!origin || origin === self) continue;
    if (!servers.has(origin) && servers.size >= MAX_HOME_SERVERS) continue;
    servers.set(origin, [...(servers.get(origin) ?? []), did]);
  }
  return servers;
}

async function peerSource(
  peerUrl: string,
  viewerDid: string,
  limit: number,
  cursor: string | undefined,
  hostedHere: Set<string>,
  deadline: number,
  unreachable: string[],
  unreachablePeers: string[],
  /** For a server asked only because home records name it: the communities they claim there. */
  claimed: string[] | null = null,
): Promise<SourceResult> {
  const remote = getRemoteActivityClient();
  let communities: string[];
  try {
    communities = await beforeDeadline(
      cached(membershipCache, `${viewerDid}\u0000${peerUrl}`, config.federation.cacheTtlMs,
        () => withHardTimeout((signal) => remote.listMemberships(peerUrl, viewerDid, signal))),
      deadline,
    );
  } catch {
    // A configured peer is named; a server reached through home records is
    // not a peer, so the communities that sent us there are.
    if (claimed) unreachable.push(...claimed);
    else unreachablePeers.push(peerUrl);
    return { lists: [], truncated: false };
  }

  communities = [...new Set(communities)]
    .filter((did) => !hostedHere.has(did))
    .slice(0, MAX_REMOTE_COMMUNITIES_PER_PEER);
  if (communities.length === 0) return { lists: [], truncated: false };

  // limit + 1 so a next page can be detected, within what the peer accepts.
  const ask = Math.min(limit + 1, MAX_ACTIVITY_LIMIT);
  const pages = await Promise.all(chunk(communities, MAX_COMMUNITIES_PER_CALL).map(async (group) => {
    const key = [viewerDid, peerUrl, group.join(','), ask, cursor ?? ''].join('\u0000');
    try {
      const page = await beforeDeadline(
        cached(remoteFeedCache, key, REMOTE_FEED_TTL_MS,
          () => withHardTimeout((signal) => remote.listActivity(peerUrl, viewerDid, group, ask, cursor, signal))),
        deadline,
      );
      const allowed = new Set(group);
      const entries = page.entries
        .map((e) => sanitizeRemoteEntry(e, allowed))
        .filter((e): e is ActivityEntry => e !== null);
      return { entries, truncated: entries.length >= ask };
    } catch {
      unreachable.push(...group);
      return { entries: [] as ActivityEntry[], truncated: false };
    }
  }));
  return { lists: pages.map((p) => p.entries), truncated: pages.some((p) => p.truncated) };
}

export async function buildUserTimeline(
  viewer: AuthContext,
  limit: number,
  cursor: ActivityCursor | null,
  rawCursor: string | undefined,
): Promise<UserTimeline> {
  const unreachable: string[] = [];
  const unreachablePeers: string[] = [];
  const deadline = Date.now() + remoteTimeoutMs;

  const local = await localMemberships(viewer);
  const hosted = new Set(local.communities);
  const federating = config.federation.enabled;
  const peers = federating ? runtimeSettings().federationPeers : [];
  const peerOrigins = new Set(peers.map(originOf).filter((o): o is string => o !== null));

  // Servers named by the viewer's own membership records, other than the
  // configured peers (asked anyway): resolved, then asked like a peer.
  const homeSources = (async (): Promise<SourceResult[]> => {
    if (!federating) return [];
    const claims = await homeMembershipClaims(viewer.did);
    if (claims.length === 0) return [];
    const servers = await homeServers(claims, deadline);
    return Promise.all([...servers]
      .filter(([origin]) => !peerOrigins.has(origin))
      .map(([origin, claimed]) =>
        peerSource(origin, viewer.did, limit, rawCursor, hosted, deadline, unreachable, unreachablePeers, claimed)));
  })();

  const [localLists, fromHome, ...remote] = await Promise.all([
    local.communities.length > 0
      ? loadLocalActivity(local.communities, local.withJoinRequests, limit + 1, cursor)
      : Promise.resolve([] as ActivityEntry[][]),
    homeSources,
    ...peers.map((peerUrl) =>
      peerSource(peerUrl, viewer.did, limit, rawCursor, hosted, deadline, unreachable, unreachablePeers)),
  ]) as [ActivityEntry[][], SourceResult[], ...SourceResult[]];

  const sources: SourceResult[] = [{ lists: localLists, truncated: false }, ...fromHome, ...remote];
  const page = mergeActivityPage(sources.flatMap((s) => s.lists), limit, cursor);
  // A peer caps a page at 100: when it had more and the page is full, there
  // is a next page even though fewer than limit + 1 entries were seen.
  if (!page.cursor && page.entries.length === limit && sources.some((s) => s.truncated)) {
    page.cursor = encodeActivityCursor(page.entries[page.entries.length - 1]);
  }
  return { ...page, unreachable, unreachablePeers };
}
