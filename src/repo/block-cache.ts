/**
 * Process-wide block cache for MST traversal.
 *
 * AT Protocol repo blocks are content-addressed — the CID is a hash of
 * the block bytes. That means a block at CID X always has the same
 * content; once we've fetched it, we can keep it in memory indefinitely
 * without invalidation. The only failure mode is unbounded memory
 * growth, which we cap with simple insertion-order eviction (~LRU
 * for our usage pattern, where reads tend to hit the same recent CIDs).
 *
 * Why this matters: every record write triggers `Repo.load(storage)`,
 * which fetches the root block and then walks the MST until it finds
 * the right node. For a 10K-member community that can be many block
 * fetches per write. With this cache, the second write to the same
 * repo (within the same 30 minutes or so of activity) does ~zero
 * database I/O for the MST traversal — only the new commit's writes
 * hit Postgres.
 *
 * Keying by (did, cid) rather than just cid: our `repo_blocks` table
 * is partitioned per DID. Two communities with the same block content
 * have distinct rows, and we don't want one community's cache to mask
 * another's missing block (would return wrong "not missing" answers).
 */

const MAX_ENTRIES = 10_000;

const cache = new Map<string, Uint8Array>();

function key(did: string, cidStr: string): string {
  return `${did}::${cidStr}`;
}

export function blockCacheGet(did: string, cidStr: string): Uint8Array | undefined {
  return cache.get(key(did, cidStr));
}

export function blockCacheSet(did: string, cidStr: string, bytes: Uint8Array): void {
  if (cache.size >= MAX_ENTRIES) {
    // Evict oldest insertion. Map iteration order is insertion order.
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key(did, cidStr), bytes);
}

/**
 * Drop a block from the cache after the underlying DB row is deleted.
 * Correctness doesn't strictly require this — removed blocks aren't
 * referenced by the current MST and won't be queried by `getBytes` —
 * but it keeps memory usage tidy on long-lived processes.
 */
export function blockCacheDelete(did: string, cidStr: string): void {
  cache.delete(key(did, cidStr));
}

/**
 * Test helper. Not part of the regular interface.
 */
export function _clearBlockCache(): void {
  cache.clear();
}

export function _blockCacheSize(): number {
  return cache.size;
}
