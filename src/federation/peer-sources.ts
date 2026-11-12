/**
 * Where community-discovery peers come from (#41).
 *
 * Kept apart from fetching and merging on purpose: today the only source is
 * the operator's FEDERATION_PEERS list, but a central directory (or anything
 * else that can name OpenFederation servers) is meant to slot in later as one
 * more PeerSource, without touching how peers are fetched, validated, cached
 * or merged. See docs/IMPLEMENTATION_STATUS.md, "Cross-server community
 * discovery".
 *
 * This module must not import config.ts: config.ts uses the parsers below.
 */

/** Something that can name peer PDS base URLs (origins). */
export interface PeerSource {
  /** Short label for logs. */
  readonly name: string;
  /** Peer origins, e.g. `https://pds.example.org`. May be empty. */
  listPeers(): Promise<string[]>;
}

/** A source backed by a list the caller already has (the configured peers). */
export function staticPeerSource(name: string, getUrls: () => readonly string[]): PeerSource {
  return { name, listPeers: async () => [...getUrls()] };
}

/**
 * Ask every source, keep the answers that work, and return each peer origin
 * once, in source order, never this PDS itself. A source that throws counts
 * as naming no peers.
 */
export async function resolvePeerUrls(sources: readonly PeerSource[], selfUrl: string): Promise<string[]> {
  const lists = await Promise.all(sources.map(async (source) => {
    try {
      return await source.listPeers();
    } catch (err) {
      console.warn(`Peer source ${source.name} failed:`, err instanceof Error ? err.message : err);
      return [];
    }
  }));
  return mergePeerLists(...lists).filter((url) => url !== normaliseOrigin(selfUrl));
}

/** Merge peer lists into origins, first occurrence wins; unparseable entries are dropped. */
export function mergePeerLists(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const origin = normaliseOrigin(raw);
      if (!origin || seen.has(origin)) continue;
      seen.add(origin);
      out.push(origin);
    }
  }
  return out;
}

function normaliseOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Parse FEDERATION_PEERS: comma-separated base URLs of other OpenFederation
 * servers. Each becomes its origin (a path is ignored). HTTPS is required in
 * production; credentials and other schemes are refused. Throws on any
 * invalid entry so a typo stops the server instead of silently dropping a peer.
 */
export function parseFederationPeers(
  raw: string | undefined,
  opts: { isProduction: boolean; selfUrl: string },
): string[] {
  if (!raw || !raw.trim()) return [];
  const self = opts.selfUrl ? normaliseOrigin(opts.selfUrl) : null;
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`FEDERATION_PEERS: "${value}" is not a URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`FEDERATION_PEERS: "${value}" must be an https URL`);
    }
    if (opts.isProduction && url.protocol !== 'https:') {
      throw new Error(`FEDERATION_PEERS: "${value}" must use https in production`);
    }
    if (url.username || url.password) {
      throw new Error(`FEDERATION_PEERS: "${value}" must not contain credentials`);
    }
    if (url.origin === self || out.includes(url.origin)) continue;
    out.push(url.origin);
  }
  return out;
}
