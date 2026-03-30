/**
 * Bounded, time-limited cache for decrypted Secp256k1 keypairs.
 *
 * Eliminates repeated PBKDF2 key derivation on every write operation.
 * Cache entries expire after TTL and the cache is bounded by MAX_SIZE
 * to prevent unbounded memory growth.
 *
 * Security notes:
 * - Cached keypairs are the decrypted result (same as what lives in memory
 *   during a single request without caching). The security boundary is
 *   KEY_ENCRYPTION_SECRET, not the per-request lifetime.
 * - TTL limits exposure window. MAX_SIZE limits memory.
 * - invalidate() must be called on key rotation.
 */

import type { Secp256k1Keypair } from '@atproto/crypto';

interface CacheEntry {
  keypair: Secp256k1Keypair;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_SIZE = 500;

const cache = new Map<string, CacheEntry>();

let ttlMs = DEFAULT_TTL_MS;
let maxSize = DEFAULT_MAX_SIZE;

export function configureKeypairCache(opts: { ttlMs?: number; maxSize?: number }): void {
  if (opts.ttlMs !== undefined) ttlMs = opts.ttlMs;
  if (opts.maxSize !== undefined) maxSize = opts.maxSize;
}

export function getCachedKeypair(did: string): Secp256k1Keypair | null {
  const entry = cache.get(did);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(did);
    return null;
  }
  return entry.keypair;
}

export function setCachedKeypair(did: string, keypair: Secp256k1Keypair): void {
  // Evict oldest entry if at capacity
  if (cache.size >= maxSize && !cache.has(did)) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(did, {
    keypair,
    expiresAt: Date.now() + ttlMs,
  });
}

export function invalidateKeypair(did: string): void {
  cache.delete(did);
}

export function clearKeypairCache(): void {
  cache.clear();
}

export function keypairCacheSize(): number {
  return cache.size;
}
