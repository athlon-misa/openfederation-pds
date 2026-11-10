/**
 * AT Protocol Compliant Repository Engine
 *
 * Wraps @atproto/repo Repo class with PgBlockstore for real MST repos,
 * signed commits, and CAR export. Uses records_index as a denormalized
 * read cache, updated in the same transaction as each commit.
 */

import { CID } from 'multiformats/cid';
import { TID } from '@atproto/common-web';
import {
  Repo,
  WriteOpAction,
  getFullRepo,
  cidForRecord,
} from '@atproto/repo';
import type {
  RecordCreateOp,
  RecordWriteOp,
  CommitData,
} from '@atproto/repo';
import type { Keypair } from '@atproto/crypto';
import type { PoolClient } from 'pg';
import { PgBlockstore, RepoConcurrentWriteError } from './pg-blockstore.js';
import { query } from '../db/client.js';

import { MEMBER_COLLECTION, projectMemberRow } from '../community/projections.js';

type IndexOp = {
  action: WriteOpAction;
  collection: string;
  rkey: string;
  record?: Record<string, unknown>;
  cid?: string;
};

/**
 * One writer at a time per repo, in this process. A commit is "load the root,
 * build a tree on it, replace the root"; two of those interleaving is what the
 * compare-and-swap in `PgBlockstore.applyCommit` refuses. Queuing here means
 * requests to the same repo wait their turn instead of colliding and retrying.
 * Other replicas are not covered by this queue; the compare-and-swap is, and
 * `commit` retries when it loses to one.
 */
const repoWriteQueues = new Map<string, Promise<unknown>>();

function serializeRepoWrite<T>(did: string, operation: () => Promise<T>): Promise<T> {
  const previous = repoWriteQueues.get(did) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.catch(() => undefined);
  repoWriteQueues.set(did, settled);
  void settled.then(() => {
    if (repoWriteQueues.get(did) === settled) repoWriteQueues.delete(did);
  });
  return run;
}

const MAX_COMMIT_ATTEMPTS = 5;

export class RepoEngine {
  private storage: PgBlockstore;

  constructor(public readonly did: string) {
    this.storage = new PgBlockstore(did);
  }

  /**
   * Create a new repository with an initial signed commit.
   */
  async createRepo(
    keypair: Keypair,
    initialWrites?: Array<{ collection: string; rkey: string; record: Record<string, unknown> }>
  ): Promise<void> {
    const createOps: RecordCreateOp[] = (initialWrites || []).map(w => ({
      action: WriteOpAction.Create,
      collection: w.collection,
      rkey: w.rkey,
      record: w.record,
    }));

    const indexOps: IndexOp[] = (initialWrites || []).map(w => ({
      action: WriteOpAction.Create,
      collection: w.collection,
      rkey: w.rkey,
      record: w.record,
    }));

    await serializeRepoWrite(this.did, async () => {
      const commit = await Repo.formatInitCommit(this.storage, this.did, keypair, createOps);
      await this.storage.applyCommit(commit, client => this.applyIndexOps(client, indexOps));
    });
  }

  /**
   * Build a commit on the current root and apply it, with the read cache
   * updated in the same transaction.
   *
   * `plan` is called with the repo's turn held, and again on each retry, so
   * whatever it reads (which keys already exist, for instance) is read against
   * the state the commit will actually be built on.
   */
  private async commit<T>(
    keypair: Keypair,
    plan: () => Promise<{ writeOps: RecordWriteOp[]; indexOps: IndexOp[]; result: T }>,
  ): Promise<T> {
    return serializeRepoWrite(this.did, async () => {
      for (let attempt = 1; ; attempt++) {
        const repo = await Repo.load(this.storage);
        const { writeOps, indexOps, result } = await plan();
        const commit = await repo.formatCommit(writeOps, keypair);
        try {
          await this.storage.applyCommit(commit, client => this.applyIndexOps(client, indexOps));
          return result;
        } catch (err) {
          // Another replica committed between our load and our apply.
          if (!(err instanceof RepoConcurrentWriteError) || attempt >= MAX_COMMIT_ATTEMPTS) throw err;
        }
      }
    });
  }

  /**
   * Write (create or update) a record, producing a new signed commit.
   */
  async putRecord(
    keypair: Keypair,
    collection: string,
    rkey: string,
    record: Record<string, unknown>
  ): Promise<{ cid: string; uri: string }> {
    // Compute CID once, before the commit
    const cidStr = (await cidForRecord(record)).toString();
    const uri = `at://${this.did}/${collection}/${rkey}`;

    return this.commit(keypair, async () => {
      // Create or update is decided from records_index, which changes in the
      // same transaction as the tree, so it says what the tree holds.
      const existingResult = await query<{ cid: string }>(
        'SELECT cid FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
        [this.did, collection, rkey]
      );
      const action = existingResult.rows.length > 0 ? WriteOpAction.Update : WriteOpAction.Create;
      return {
        writeOps: [{ action, collection, rkey, record }],
        indexOps: [{ action, collection, rkey, record, cid: cidStr }],
        result: { cid: cidStr, uri },
      };
    });
  }

  /**
   * Write and delete several records in **one** signed commit (#188).
   *
   * The atomicity this buys is not cosmetic. Governance resolution used to
   * close a proposal in one commit and perform the change it decided in
   * another, so a crash between them left a durable `approved` proposal whose
   * change had never happened — and, because the proposal was no longer
   * pending, nothing would ever revisit it. One commit removes the window
   * rather than making it recoverable: `PgBlockstore.applyCommit` writes the
   * new blocks and the new root inside a single Postgres transaction, so either
   * every record in the batch is in the repo or none of them is.
   *
   * It is also the more faithful reading of the protocol. A decision and the
   * change it authorizes are one act, and a repo revision is what ATProto has
   * to say "these happened together".
   *
   * `records_index` is updated in that same transaction, as it is for every
   * other write, so the read cache never disagrees with the signed tree.
   */
  async applyWrites(
    keypair: Keypair,
    ops: Array<
      | { action: 'write'; collection: string; rkey: string; record: Record<string, unknown> }
      | { action: 'delete'; collection: string; rkey: string }
    >,
  ): Promise<Array<{ collection: string; rkey: string; uri: string; cid?: string }>> {
    if (ops.length === 0) return [];

    const cids = new Map<string, string>();
    for (const op of ops) {
      if (op.action === 'write') {
        cids.set(`${op.collection}/${op.rkey}`, (await cidForRecord(op.record)).toString());
      }
    }

    return this.commit(keypair, async () => {
      // Which writes are creates and which are updates, in one round-trip rather
      // than one per op.
      const writeKeys = [...cids.keys()];
      const existing = new Set<string>();
      if (writeKeys.length > 0) {
        const rows = await query<{ collection: string; rkey: string }>(
          `SELECT collection, rkey FROM records_index
           WHERE community_did = $1 AND (collection || '/' || rkey) = ANY($2)`,
          [this.did, writeKeys],
        );
        for (const row of rows.rows) existing.add(`${row.collection}/${row.rkey}`);
      }

      const writeOps: RecordWriteOp[] = [];
      const result: Array<{ collection: string; rkey: string; uri: string; cid?: string }> = [];
      const indexOps: IndexOp[] = [];

      for (const op of ops) {
        const uri = `at://${this.did}/${op.collection}/${op.rkey}`;
        if (op.action === 'delete') {
          writeOps.push({ action: WriteOpAction.Delete, collection: op.collection, rkey: op.rkey });
          indexOps.push({ action: WriteOpAction.Delete, collection: op.collection, rkey: op.rkey });
          result.push({ collection: op.collection, rkey: op.rkey, uri });
          continue;
        }
        const key = `${op.collection}/${op.rkey}`;
        const action = existing.has(key) ? WriteOpAction.Update : WriteOpAction.Create;
        const cid = cids.get(key)!;
        writeOps.push({ action, collection: op.collection, rkey: op.rkey, record: op.record });
        indexOps.push({ action, collection: op.collection, rkey: op.rkey, record: op.record, cid });
        result.push({ collection: op.collection, rkey: op.rkey, uri, cid });
      }

      return { writeOps, indexOps, result };
    });
  }

  /**
   * Delete a record, producing a new signed commit.
   */
  async deleteRecord(
    keypair: Keypair,
    collection: string,
    rkey: string
  ): Promise<void> {
    await this.commit(keypair, async () => ({
      writeOps: [{ action: WriteOpAction.Delete, collection, rkey }],
      indexOps: [{ action: WriteOpAction.Delete, collection, rkey }],
      result: undefined,
    }));
  }

  /**
   * Get a record from the records_index cache (fast path).
   */
  async getRecord(
    collection: string,
    rkey: string
  ): Promise<{ record: Record<string, unknown>; cid: string } | null> {
    const result = await query<{ record: Record<string, unknown>; cid: string }>(
      'SELECT record, cid FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
      [this.did, collection, rkey]
    );

    if (result.rows.length === 0) return null;
    return {
      record: result.rows[0].record,
      cid: result.rows[0].cid,
    };
  }

  /**
   * List records in a collection from records_index cache.
   */
  async listRecords(
    collection: string,
    limit: number = 50,
    cursor?: string,
    reverse = false,
  ): Promise<{ records: Array<{ rkey: string; record: Record<string, unknown>; cid: string }>; cursor?: string }> {
    let queryStr = `
      SELECT rkey, record, cid
      FROM records_index
      WHERE community_did = $1 AND collection = $2
    `;
    const params: unknown[] = [this.did, collection];

    if (cursor) {
      queryStr += ` AND rkey ${reverse ? '<' : '>'} $3`;
      params.push(cursor);
    }

    queryStr += ` ORDER BY rkey ${reverse ? 'DESC' : 'ASC'} LIMIT $` + (params.length + 1);
    params.push(limit + 1);

    const result = await query<{ rkey: string; record: Record<string, unknown>; cid: string }>(queryStr, params);

    const records = result.rows.slice(0, limit).map(row => ({
      rkey: row.rkey,
      record: row.record,
      cid: row.cid,
    }));

    const hasMore = result.rows.length > limit;
    const nextCursor = hasMore ? records[records.length - 1].rkey : undefined;

    return { records, cursor: nextCursor };
  }

  /**
   * Export the full repository as a CAR byte stream.
   */
  async exportAsCAR(): Promise<AsyncIterable<Uint8Array>> {
    const rootCid = await this.storage.getRoot();
    if (!rootCid) {
      throw new Error(`No repo found for DID: ${this.did}`);
    }
    return getFullRepo(this.storage, rootCid);
  }

  /**
   * Export all records as a flat list (for legacy JSON export).
   */
  async exportAllRecords(limit?: number): Promise<Array<{ collection: string; rkey: string; cid: string; record: Record<string, unknown> }>> {
    const limitClause = limit === undefined ? '' : ' LIMIT $2';
    const params = limit === undefined ? [this.did] : [this.did, limit];
    const result = await query<{ collection: string; rkey: string; cid: string; record: Record<string, unknown> }>(
      `SELECT collection, rkey, cid, record FROM records_index WHERE community_did = $1 ORDER BY collection, rkey${limitClause}`,
      params,
    );
    return result.rows;
  }

  /**
   * Check if a repo exists for this DID.
   */
  async hasRepo(): Promise<boolean> {
    const root = await this.storage.getRoot();
    return root !== null;
  }

  /**
   * Get the root CID of the repo.
   */
  async getRoot(): Promise<CID | null> {
    return this.storage.getRoot();
  }

  /**
   * Get the underlying storage for sync endpoints.
   */
  getStorage(): PgBlockstore {
    return this.storage;
  }

  /**
   * Generate a new TID using ATProto's standard TID algorithm.
   */
  static generateTid(): string {
    return TID.nextStr();
  }

  /**
   * Apply a commit's changes to the `records_index` read cache, on the
   * commit's own transaction. For member-collection records this also fans
   * role/kind/tags/attributes out to the `members_unique` projection (and
   * removes the row on delete) so handlers don't have to remember to sync
   * separately. Display fields (display_name/avatar_url) are fanned out by
   * `fanOutDisplayFields` from the profile-update handler; that projection
   * crosses DIDs and lives outside the engine.
   */
  private async applyIndexOps(client: PoolClient, ops: IndexOp[]): Promise<void> {
    for (const op of ops) {
      if (op.action === WriteOpAction.Delete) {
        await client.query(
          'DELETE FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
          [this.did, op.collection, op.rkey]
        );
        if (op.collection === MEMBER_COLLECTION) {
          await client.query(
            'DELETE FROM members_unique WHERE community_did = $1 AND record_rkey = $2',
            [this.did, op.rkey]
          );
        }
        continue;
      }
      if (!op.record) continue;

      const cidStr = op.cid || (await cidForRecord(op.record)).toString();

      await client.query(
        `INSERT INTO records_index (community_did, collection, rkey, cid, record, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT (community_did, collection, rkey)
         DO UPDATE SET cid = $4, record = $5, updated_at = CURRENT_TIMESTAMP`,
        [this.did, op.collection, op.rkey, cidStr, JSON.stringify(op.record)]
      );

      if (op.collection === MEMBER_COLLECTION) {
        await projectMemberRow(client, this.did, op.rkey, op.record);
      }
    }
  }
}
