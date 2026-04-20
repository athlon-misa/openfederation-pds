/**
 * DID resolver with in-memory key caching.
 *
 * Wraps @atproto/identity's DidResolver + MemoryCache to provide a singleton
 * used for verifying inbound cross-PDS service-auth JWTs. Resolves both
 * did:plc (via the configured PLC directory) and did:web (via HTTPS).
 *
 * Cached DID documents are fresh for 5 minutes; stale entries are refreshed
 * lazily on next use.
 */

import { DidResolver } from '@atproto/identity';
import { MemoryCache } from '@atproto/identity';
import { config } from '../config.js';

const STALE_TTL_MS = 5 * 60 * 1000; // 5 minutes — re-resolve after this
const MAX_TTL_MS = 60 * 60 * 1000;  // 1 hour — hard expiry

let resolver: DidResolver | null = null;
let cache: MemoryCache | null = null;

export function getDidResolver(): DidResolver {
  if (resolver) return resolver;
  cache = new MemoryCache(STALE_TTL_MS, MAX_TTL_MS);
  resolver = new DidResolver({
    plcUrl: config.plc.directoryUrl,
    didCache: cache,
    timeout: 3000,
  });
  return resolver;
}

/** Clear the DID resolver cache. Exposed for tests. */
export async function clearDidResolverCache(): Promise<void> {
  if (cache) await cache.clear();
}
