/**
 * Asking another PDS about a viewer's communities there (#42).
 *
 * Membership is a record in the *community's* repo, on the community's PDS.
 * Since #385 the member's own repo also holds a
 * `net.openfederation.community.membership` record per public community,
 * which tells the home PDS which servers to ask; configured peers are asked
 * too, for memberships with no home record (private communities, older
 * joins). The community's PDS confirms each membership: a home record it does
 * not confirm is a bookmark. For each such server it calls, with a
 * service-auth token signed by the viewer's own key (aud = the peer's service
 * DID, lxm = the method):
 *
 *   net.openfederation.community.listMine              which communities, there
 *   net.openfederation.activity.listCommunityActivity  their activity, batched
 *
 * The peer checks the token against the viewer's DID document and applies its
 * own privacy rules; nothing here can widen what the viewer may see there.
 * A community on a server that is neither a configured peer nor named by a
 * home membership record is not reached.
 */
import { config } from '../config.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { assertServerMaySign } from '../repo/device-signing-state.js';
import { signServiceAuthJwt } from '../auth/service-auth.js';
import { assertPublicHttpsUrl, readLimitedText } from '../security/outbound-fetch.js';
import { resolveDidToPds } from '../federation/remote-verify.js';

export const LIST_MINE_NSID = 'net.openfederation.community.listMine';
export const LIST_ACTIVITY_NSID = 'net.openfederation.activity.listCommunityActivity';
/** listCommunityActivity takes at most this many communities per call. */
export const MAX_COMMUNITIES_PER_CALL = 25;

const MAX_RESPONSE_BYTES = 512 * 1024;
const TOKEN_TTL_SEC = 60;

export interface RemoteActivityPage {
  entries: unknown[];
  unavailable: string[];
}

export interface RemoteActivityClient {
  /**
   * The PDS a community lives on, from its DID document (#385: a membership
   * record at home names the community, not its server). Optional so test
   * clients may leave it out; then the DID is resolved over the network.
   */
  resolveCommunityPds?(did: string, signal: AbortSignal): Promise<string | null>;
  /** DIDs of the communities on `peerUrl` that `viewerDid` is a member of. */
  listMemberships(peerUrl: string, viewerDid: string, signal: AbortSignal): Promise<string[]>;
  /** Activity of `communities` on `peerUrl`, newest first, as the peer returns it. */
  listActivity(
    peerUrl: string,
    viewerDid: string,
    communities: string[],
    limit: number,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<RemoteActivityPage>;
}

// ── HTTP client ──────────────────────────────────────────────────────────────

const peerDidCache = new Map<string, { did: string; at: number }>();

async function getJson(url: URL, signal: AbortSignal, token?: string): Promise<unknown> {
  const safe = await assertPublicHttpsUrl(url.toString());
  const response = await fetch(safe, {
    signal,
    redirect: 'error',
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error(`${url.pathname} answered ${response.status}`);
  return JSON.parse(await readLimitedText(response, MAX_RESPONSE_BYTES));
}

/** The peer's service DID (the `aud` it accepts), from its describeServer. */
async function peerServiceDid(peerUrl: string, signal: AbortSignal): Promise<string> {
  const cached = peerDidCache.get(peerUrl);
  if (cached && Date.now() - cached.at < config.federation.cacheTtlMs) return cached.did;
  const body = await getJson(new URL('/xrpc/com.atproto.server.describeServer', peerUrl), signal) as { did?: unknown };
  if (typeof body?.did !== 'string' || !body.did.startsWith('did:')) throw new Error('peer has no service DID');
  peerDidCache.set(peerUrl, { did: body.did, at: Date.now() });
  return body.did;
}

async function tokenFor(viewerDid: string, aud: string, lxm: string): Promise<string> {
  // Signed with the viewer's atproto key. Under device signing (#240) that
  // key is on their device, so the server cannot ask other servers on their
  // behalf: those servers are reported unavailable, and only this server's
  // communities are listed.
  await assertServerMaySign(viewerDid);
  const keypair = await getKeypairForDid(viewerDid);
  return signServiceAuthJwt({
    keypair,
    iss: viewerDid,
    aud,
    lxm,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC,
  });
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export const httpRemoteActivityClient: RemoteActivityClient = {
  async resolveCommunityPds(did) {
    return resolveDidToPds(did);
  },

  async listMemberships(peerUrl, viewerDid, signal) {
    const aud = await peerServiceDid(peerUrl, signal);
    const url = new URL(`/xrpc/${LIST_MINE_NSID}`, peerUrl);
    url.searchParams.set('limit', '100');
    const body = await getJson(url, signal, await tokenFor(viewerDid, aud, LIST_MINE_NSID)) as { communities?: unknown };
    const dids = Array.isArray(body?.communities)
      ? body.communities
        .map((c) => (typeof c === 'object' && c !== null ? (c as { did?: unknown }).did : undefined))
        .filter((d): d is string => typeof d === 'string' && d.startsWith('did:'))
      : [];
    // Keep only communities whose DID document names this peer as their PDS:
    // a peer speaks for the communities it hosts, not for anyone else's.
    const hosted = await Promise.all(dids.map(async (did) => {
      const pds = await resolveDidToPds(did);
      return pds && sameOrigin(pds, peerUrl) ? did : null;
    }));
    return hosted.filter((d): d is string => d !== null);
  },

  async listActivity(peerUrl, viewerDid, communities, limit, cursor, signal) {
    const aud = await peerServiceDid(peerUrl, signal);
    const url = new URL(`/xrpc/${LIST_ACTIVITY_NSID}`, peerUrl);
    for (const c of communities) url.searchParams.append('community', c);
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);
    const body = await getJson(url, signal, await tokenFor(viewerDid, aud, LIST_ACTIVITY_NSID)) as {
      entries?: unknown; unavailable?: unknown;
    };
    return {
      entries: Array.isArray(body?.entries) ? body.entries : [],
      unavailable: Array.isArray(body?.unavailable)
        ? body.unavailable.filter((d): d is string => typeof d === 'string')
        : [],
    };
  },
};

let client: RemoteActivityClient = httpRemoteActivityClient;

export function getRemoteActivityClient(): RemoteActivityClient {
  return client;
}

/** Test seam: replace the client (pass null to restore the HTTP one). */
export function _setRemoteActivityClient(next: RemoteActivityClient | null): void {
  client = next ?? httpRemoteActivityClient;
}

/** Forget the peers' service DIDs (the demo reset, src/server/fresh-start.ts). */
export function clearPeerDidCache(): void {
  peerDidCache.clear();
}
