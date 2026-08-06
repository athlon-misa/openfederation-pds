/**
 * AT Protocol Compliant Repository Engine
 *
 * Wraps @atproto/repo Repo class with PgBlockstore for real MST repos,
 * signed commits, and CAR export. Uses records_index as a denormalized
 * read cache (synced after every commit).
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
import { PgBlockstore } from './pg-blockstore.js';
import { query, withTransaction } from '../db/client.js';

const MEMBER_COLLECTION = 'net.openfederation.community.member';

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

    const repo = await Repo.create(this.storage, this.did, keypair, createOps);

    // Sync records_index cache from initial writes
    if (initialWrites) {
      await this.syncRecordsIndex(initialWrites.map(w => ({
        action: WriteOpAction.Create as const,
        collection: w.collection,
        rkey: w.rkey,
        record: w.record,
      })));
    }
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
    const repo = await Repo.load(this.storage);

    // Check if record exists using records_index (fast SQL lookup)
    // instead of loading the MST, which avoids an expensive tree traversal
    const existingResult = await query<{ cid: string }>(
      'SELECT cid FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
      [this.did, collection, rkey]
    );
    const action = existingResult.rows.length > 0 ? WriteOpAction.Update : WriteOpAction.Create;

    // Compute CID once, before the commit
    const recordCid = await cidForRecord(record);
    const cidStr = recordCid.toString();

    const writeOp: RecordWriteOp = { action, collection, rkey, record };
    await repo.applyWrites(writeOp, keypair);

    const uri = `at://${this.did}/${collection}/${rkey}`;

    // Pass pre-computed CID to avoid recomputation in syncRecordsIndex
    await this.syncRecordsIndex([{ action, collection, rkey, record, cid: cidStr }]);

    return { cid: cidStr, uri };
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
   * `records_index` is synced after the commit, as it is for every other write.
   * It is a derived cache, so a crash in between leaves it stale rather than
   * wrong: the repo is the record, and the lazy sweep re-derives from the cache
   * and converges, because writing the same records again produces the same
   * CIDs.
   */
  async applyWrites(
    keypair: Keypair,
    ops: Array<
      | { action: 'write'; collection: string; rkey: string; record: Record<string, unknown> }
      | { action: 'delete'; collection: string; rkey: string }
    >,
  ): Promise<Array<{ collection: string; rkey: string; uri: string; cid?: string }>> {
    if (ops.length === 0) return [];

    const repo = await Repo.load(this.storage);

    // Which writes are creates and which are updates, in one round-trip rather
    // than one per op.
    const writeKeys = ops
      .filter(op => op.action === 'write')
      .map(op => `${op.collection}/${op.rkey}`);
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
    const results: Array<{ collection: string; rkey: string; uri: string; cid?: string }> = [];
    const indexOps: Array<{ action: WriteOpAction; collection: string; rkey: string; record?: Record<string, unknown>; cid?: string }> = [];

    for (const op of ops) {
      const uri = `at://${this.did}/${op.collection}/${op.rkey}`;
      if (op.action === 'delete') {
        writeOps.push({ action: WriteOpAction.Delete, collection: op.collection, rkey: op.rkey });
        indexOps.push({ action: WriteOpAction.Delete, collection: op.collection, rkey: op.rkey });
        results.push({ collection: op.collection, rkey: op.rkey, uri });
        continue;
      }
      const action = existing.has(`${op.collection}/${op.rkey}`) ? WriteOpAction.Update : WriteOpAction.Create;
      const cid = (await cidForRecord(op.record)).toString();
      writeOps.push({ action, collection: op.collection, rkey: op.rkey, record: op.record });
      indexOps.push({ action, collection: op.collection, rkey: op.rkey, record: op.record, cid });
      results.push({ collection: op.collection, rkey: op.rkey, uri, cid });
    }

    await repo.applyWrites(writeOps, keypair);

    for (const op of indexOps) {
      if (op.action === WriteOpAction.Delete) {
        await this.removeFromRecordsIndex(op.collection, op.rkey);
      } else {
        await this.syncRecordsIndex([{
          action: op.action,
          collection: op.collection,
          rkey: op.rkey,
          record: op.record!,
          cid: op.cid,
        }]);
      }
    }

    return results;
  }

  /**
   * Drop a record from the read cache, and from the membership uniqueness index
   * when it was a member record. Shared by `deleteRecord` and `applyWrites` so
   * a delete means the same thing whichever way it was issued.
   */
  private async removeFromRecordsIndex(collection: string, rkey: string): Promise<void> {
    await query(
      'DELETE FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
      [this.did, collection, rkey]
    );
    if (collection === MEMBER_COLLECTION) {
      await query(
        'DELETE FROM members_unique WHERE community_did = $1 AND record_rkey = $2',
        [this.did, rkey]
      );
    }
  }

  /**
   * Delete a record, producing a new signed commit.
   */
  async deleteRecord(
    keypair: Keypair,
    collection: string,
    rkey: string
  ): Promise<void> {
    const repo = await Repo.load(this.storage);

    const writeOp: RecordWriteOp = {
      action: WriteOpAction.Delete,
      collection,
      rkey,
    };

    await repo.applyWrites(writeOp, keypair);

    await this.removeFromRecordsIndex(collection, rkey);
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
   * Sync the records_index cache after write operations. The MST is the
   * source of truth; records_index is a denormalized read cache. For
   * member-collection records, also fan out role/kind/tags/attributes to
   * the `members_unique` projection so handlers don't have to remember
   * to sync separately. Display fields (display_name/avatar_url) are
   * fanned out by `fanOutDisplayFields` from the profile-update handler
   * — that projection crosses DIDs and lives outside the engine.
   */
  private async syncRecordsIndex(
    ops: Array<{ action: string; collection: string; rkey: string; record?: Record<string, unknown>; cid?: string }>
  ): Promise<void> {
    await withTransaction(async (client) => {
      for (const op of ops) {
        if (op.action === WriteOpAction.Delete) {
          await client.query(
            'DELETE FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
            [this.did, op.collection, op.rkey]
          );
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

        if (op.collection === MEMBER_COLLECTION && op.record.did) {
          const rec = op.record as {
            did: string;
            handle?: string | null;
            role?: string | null;
            roleRkey?: string | null;
            kind?: string | null;
            tags?: string[] | null;
            attributes?: Record<string, unknown> | null;
          };

          await client.query(
            `INSERT INTO members_unique
               (community_did, member_did, record_rkey, handle, role, role_rkey, kind, tags, attributes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (community_did, member_did) DO UPDATE
               SET record_rkey = EXCLUDED.record_rkey,
                   handle      = COALESCE(EXCLUDED.handle, members_unique.handle),
                   role        = COALESCE(EXCLUDED.role, members_unique.role),
                   role_rkey   = EXCLUDED.role_rkey,
                   kind        = EXCLUDED.kind,
                   tags        = EXCLUDED.tags,
                   attributes  = EXCLUDED.attributes`,
            [
              this.did,
              rec.did,
              op.rkey,
              rec.handle ?? null,
              rec.role ?? null,
              rec.roleRkey ?? null,
              rec.kind ?? null,
              rec.tags ? JSON.stringify(rec.tags) : null,
              rec.attributes ? JSON.stringify(rec.attributes) : null,
            ],
          );
        }
      }
    });
  }
}
