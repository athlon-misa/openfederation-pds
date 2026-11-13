/**
 * Commits prepared for a device to sign (#240): limits, and taking one back
 * out of `pending_device_commits` for net.openfederation.repo.submitCommit.
 */
import { query } from '../db/client.js';
import type { PreparedDeviceCommit, IndexOp, BatchResult } from './repo-engine.js';

/** How long a prepared commit waits for its signature. */
export const PENDING_COMMIT_TTL_SECONDS = 300;
/** Prepared commits one account may hold at once. Only one per root can land anyway. */
export const MAX_PENDING_COMMITS = 8;
/** As com.atproto.repo.applyWrites. */
export const MAX_WRITES_PER_COMMIT = 200;

interface PendingRow {
  prev_root: string;
  since: string | null;
  rev: string;
  unsigned_commit: Buffer;
  new_blocks: Array<[string, string]>;
  removed_cids: string[];
  index_ops: IndexOp[];
  results: BatchResult;
  expired: boolean;
}

/**
 * Remove a prepared commit and return it, if it exists and belongs to `did`.
 * Taking it out is the first thing a submit does, in one statement, so the
 * same handle can never be submitted twice (a replay finds nothing), even by
 * two requests at once. `expired` is reported rather than filtered, so the
 * caller can say which it was.
 */
export async function takePendingCommit(handle: string, did: string): Promise<(PreparedDeviceCommit & { expired: boolean }) | null> {
  if (!/^[0-9a-f]{32}$/.test(handle)) return null;
  const result = await query<PendingRow>(
    `DELETE FROM pending_device_commits WHERE id = $1 AND did = $2
     RETURNING prev_root, since, rev, unsigned_commit, new_blocks, removed_cids, index_ops, results,
               (expires_at < NOW()) AS expired`,
    [handle, did],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    prevRoot: row.prev_root,
    since: row.since,
    rev: row.rev,
    unsigned: new Uint8Array(row.unsigned_commit),
    newBlocks: row.new_blocks.map(([cid, b64]) => [cid, new Uint8Array(Buffer.from(b64, 'base64'))]),
    removedCids: row.removed_cids,
    indexOps: row.index_ops,
    results: row.results,
    expired: row.expired,
  };
}

/** Drop every prepared commit of an account (device signing turned off). */
export async function dropPendingCommits(did: string): Promise<void> {
  await query('DELETE FROM pending_device_commits WHERE did = $1', [did]);
}
