/**
 * Commits prepared for a device to sign (#240): limits, and taking one back
 * out of `pending_device_commits` for net.openfederation.repo.submitCommit.
 */
import { randomBytes } from 'crypto';
import { query } from '../db/client.js';
import type { PreparedDeviceCommit, IndexOp, BatchResult, BatchOp } from './repo-engine.js';
import type { PlannedAuthorRecord } from './device-action-context.js';
import { HttpError } from '../xrpc/errors.js';

/** How long a prepared commit waits for its signature. */
export const PENDING_COMMIT_TTL_SECONDS = 300;
/** Prepared commits one account may hold at once. Only one per root can land anyway. */
export const MAX_PENDING_COMMITS = 8;
/** As com.atproto.repo.applyWrites. */
export const MAX_WRITES_PER_COMMIT = 200;

/** What a prepareAction handle finishes: the method, its input, and the writes the device signed. */
export interface PendingAction {
  method: string;
  input: Record<string, unknown>;
  ops?: BatchOp[];
}

export interface PendingCommit extends PreparedDeviceCommit {
  kind: 'commit' | 'authorSig';
  action: PendingAction | null;
  authorRecord: PlannedAuthorRecord | null;
  expired: boolean;
}

interface PendingRow {
  kind: 'commit' | 'authorSig';
  action: PendingAction | null;
  author_record: PlannedAuthorRecord | null;
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
export async function takePendingCommit(handle: string, did: string): Promise<PendingCommit | null> {
  if (!/^[0-9a-f]{32}$/.test(handle)) return null;
  const result = await query<PendingRow>(
    `DELETE FROM pending_device_commits WHERE id = $1 AND did = $2
     RETURNING prev_root, since, rev, unsigned_commit, new_blocks, removed_cids, index_ops, results,
               kind, action, author_record, (expires_at < NOW()) AS expired`,
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
    kind: row.kind,
    action: row.action,
    authorRecord: row.author_record,
    expired: row.expired,
  };
}

/**
 * Make room for one more prepared commit for `did` (expired ones are dropped
 * first, so they never count), or refuse with TooManyPendingCommits.
 */
export async function assertPendingRoom(did: string): Promise<void> {
  await query('DELETE FROM pending_device_commits WHERE expires_at < NOW()');
  const pending = await query<{ n: string }>('SELECT COUNT(*) AS n FROM pending_device_commits WHERE did = $1', [did]);
  if (parseInt(pending.rows[0].n, 10) >= MAX_PENDING_COMMITS) {
    throw new HttpError(429, 'TooManyPendingCommits', `At most ${MAX_PENDING_COMMITS} prepared commits may wait at once; submit or let them expire`);
  }
}

/**
 * Store what the device is to sign and return its handle and expiry. For an
 * author signature, `prepared` carries only the bytes to sign (the record's
 * CID); the commit columns hold empty values.
 */
export async function storePendingCommit(p: {
  did: string;
  kind: 'commit' | 'authorSig';
  unsigned: Uint8Array;
  prepared?: PreparedDeviceCommit;
  action?: PendingAction;
  authorRecord?: PlannedAuthorRecord;
}): Promise<{ handle: string; expiresAt: string }> {
  const handle = randomBytes(16).toString('hex');
  const c = p.prepared;
  const inserted = await query<{ expires_at: Date }>(
    `INSERT INTO pending_device_commits
       (id, did, prev_root, since, rev, unsigned_commit, new_blocks, removed_cids, index_ops, results,
        kind, action, author_record, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + make_interval(secs => $14))
     RETURNING expires_at`,
    [
      handle, p.did, c?.prevRoot ?? '', c?.since ?? null, c?.rev ?? '', Buffer.from(p.unsigned),
      JSON.stringify((c?.newBlocks ?? []).map(([cid, bytes]) => [cid, Buffer.from(bytes).toString('base64')])),
      c?.removedCids ?? [], JSON.stringify(c?.indexOps ?? []), JSON.stringify(c?.results ?? []),
      p.kind, p.action ? JSON.stringify(p.action) : null, p.authorRecord ? JSON.stringify(p.authorRecord) : null,
      PENDING_COMMIT_TTL_SECONDS,
    ],
  );
  return { handle, expiresAt: inserted.rows[0].expires_at.toISOString() };
}

/** prepareCommit's JSON form of a prepared commit (the device's `PreparedCommit`). */
export function preparedCommitJson(did: string, handle: string, expiresAt: string, prepared: PreparedDeviceCommit): Record<string, unknown> {
  return {
    handle,
    did,
    rev: prepared.rev,
    prevRoot: prepared.prevRoot,
    unsignedCommit: Buffer.from(prepared.unsigned).toString('base64'),
    newBlocks: prepared.newBlocks.map(([cid, bytes]) => ({ cid, bytes: Buffer.from(bytes).toString('base64') })),
    writes: prepared.results,
    expiresAt,
  };
}

/** Drop every prepared commit of an account (device signing turned off). */
export async function dropPendingCommits(did: string): Promise<void> {
  await query('DELETE FROM pending_device_commits WHERE did = $1', [did]);
}
