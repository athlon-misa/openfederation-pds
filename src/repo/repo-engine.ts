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
import { query, getClient } from '../db/client.js';

export class RepoEngine {
  private storage: PgBlockstore;

  constructor(private did: string) {
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

    // Check if record exists to decide create vs update
    const existing = await repo.getRecord(collection, rkey);
    const action = existing ? WriteOpAction.Update : WriteOpAction.Create;

    const writeOp: RecordWriteOp = { action, collection, rkey, record };
    await repo.applyWrites(writeOp, keypair);

    // Compute CID for the record
    const recordCid = await cidForRecord(record);
    const cidStr = recordCid.toString();
    const uri = `at://${this.did}/${collection}/${rkey}`;

    // Sync records_index cache
    await this.syncRecordsIndex([{ action, collection, rkey, record }]);

    return { cid: cidStr, uri };
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

    // Remove from records_index cache
    await query(
      'DELETE FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
      [this.did, collection, rkey]
    );

    // Clean up members_unique if this was a member record
    if (collection === 'net.openfederation.community.member') {
      await query(
        'DELETE FROM members_unique WHERE community_did = $1 AND record_rkey = $2',
        [this.did, rkey]
      );
    }
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
    cursor?: string
  ): Promise<{ records: Array<{ rkey: string; record: Record<string, unknown>; cid: string }>; cursor?: string }> {
    let queryStr = `
      SELECT rkey, record, cid
      FROM records_index
      WHERE community_did = $1 AND collection = $2
    `;
    const params: unknown[] = [this.did, collection];

    if (cursor) {
      queryStr += ' AND rkey > $3';
      params.push(cursor);
    }

    queryStr += ' ORDER BY rkey ASC LIMIT $' + (params.length + 1);
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
  async exportAllRecords(): Promise<Array<{ collection: string; rkey: string; cid: string; record: Record<string, unknown> }>> {
    const result = await query<{ collection: string; rkey: string; cid: string; record: Record<string, unknown> }>(
      'SELECT collection, rkey, cid, record FROM records_index WHERE community_did = $1 ORDER BY collection, rkey',
      [this.did]
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
   * Sync the records_index cache after write operations.
   * The MST is the source of truth; records_index is a denormalized read cache.
   */
  private async syncRecordsIndex(
    ops: Array<{ action: string; collection: string; rkey: string; record?: Record<string, unknown> }>
  ): Promise<void> {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      for (const op of ops) {
        if (op.action === WriteOpAction.Delete) {
          await client.query(
            'DELETE FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
            [this.did, op.collection, op.rkey]
          );
        } else if (op.record) {
          const recordCid = await cidForRecord(op.record);
          const cidStr = recordCid.toString();

          await client.query(
            `INSERT INTO records_index (community_did, collection, rkey, cid, record, updated_at)
             VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
             ON CONFLICT (community_did, collection, rkey)
             DO UPDATE SET cid = $4, record = $5, updated_at = CURRENT_TIMESTAMP`,
            [this.did, op.collection, op.rkey, cidStr, JSON.stringify(op.record)]
          );

          // Sync members_unique table for member records
          if (op.collection === 'net.openfederation.community.member' && op.record.did) {
            await client.query(
              `INSERT INTO members_unique (community_did, member_did, record_rkey)
               VALUES ($1, $2, $3)
               ON CONFLICT (community_did, member_did) DO NOTHING`,
              [this.did, op.record.did as string, op.rkey]
            );
          }
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
