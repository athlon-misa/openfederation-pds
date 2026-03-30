/**
 * PostgreSQL-backed RepoStorage for AT Protocol repos.
 *
 * Implements the RepoStorage interface from @atproto/repo, storing blocks
 * in the `repo_blocks` table and root CIDs in `repo_roots`. Extends
 * ReadableBlockstore to inherit CBOR decoding helpers (readObj, readRecord, etc.).
 */

import { CID } from 'multiformats/cid';
import { ReadableBlockstore, RepoStorage, BlockMap, CommitData } from '@atproto/repo';
import { getClient, query } from '../db/client.js';

export class PgBlockstore extends ReadableBlockstore implements RepoStorage {
  constructor(private did: string) {
    super();
  }

  async getRoot(): Promise<CID | null> {
    const result = await query<{ root_cid: string }>(
      'SELECT root_cid FROM repo_roots WHERE did = $1',
      [this.did]
    );
    if (result.rows.length === 0) return null;
    return CID.parse(result.rows[0].root_cid);
  }

  async getBytes(cid: CID): Promise<Uint8Array | null> {
    const cidStr = cid.toString();
    const result = await query<{ block_bytes: Buffer }>(
      'SELECT block_bytes FROM repo_blocks WHERE community_did = $1 AND cid = $2',
      [this.did, cidStr]
    );
    if (result.rows.length === 0) return null;
    return new Uint8Array(result.rows[0].block_bytes);
  }

  async has(cid: CID): Promise<boolean> {
    const cidStr = cid.toString();
    const result = await query(
      'SELECT 1 FROM repo_blocks WHERE community_did = $1 AND cid = $2',
      [this.did, cidStr]
    );
    return result.rows.length > 0;
  }

  async getBlocks(cids: CID[]): Promise<{ blocks: BlockMap; missing: CID[] }> {
    if (cids.length === 0) {
      return { blocks: new BlockMap(), missing: [] };
    }

    const cidStrs = cids.map(c => c.toString());
    const result = await query<{ cid: string; block_bytes: Buffer }>(
      'SELECT cid, block_bytes FROM repo_blocks WHERE community_did = $1 AND cid = ANY($2)',
      [this.did, cidStrs]
    );

    const blocks = new BlockMap();
    const foundSet = new Set<string>();

    for (const row of result.rows) {
      foundSet.add(row.cid);
      const cid = CID.parse(row.cid);
      blocks.set(cid, new Uint8Array(row.block_bytes));
    }

    const missing = cids.filter(c => !foundSet.has(c.toString()));
    return { blocks, missing };
  }

  async putBlock(cid: CID, block: Uint8Array, rev: string): Promise<void> {
    const cidStr = cid.toString();
    await query(
      `INSERT INTO repo_blocks (community_did, cid, block_bytes, rev)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community_did, cid) DO UPDATE SET block_bytes = $3, rev = $4`,
      [this.did, cidStr, Buffer.from(block), rev]
    );
  }

  async putMany(blocks: BlockMap, rev: string): Promise<void> {
    if (blocks.size === 0) return;

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Batch blocks into multi-row INSERTs (max 100 per statement to stay
      // well under PostgreSQL's ~65535 parameter limit: 100 rows * 4 params = 400)
      const entries = Array.from(blocks);
      const BATCH_SIZE = 100;

      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        for (let j = 0; j < batch.length; j++) {
          const [cid, bytes] = batch[j];
          const offset = j * 4;
          placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
          values.push(this.did, cid.toString(), Buffer.from(bytes), rev);
        }

        await client.query(
          `INSERT INTO repo_blocks (community_did, cid, block_bytes, rev)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (community_did, cid) DO UPDATE SET block_bytes = EXCLUDED.block_bytes, rev = EXCLUDED.rev`,
          values
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async updateRoot(cid: CID, rev: string): Promise<void> {
    const cidStr = cid.toString();
    await query(
      `INSERT INTO repo_roots (did, root_cid, rev, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (did) DO UPDATE SET root_cid = $2, rev = $3, updated_at = CURRENT_TIMESTAMP`,
      [this.did, cidStr, rev]
    );
  }

  async applyCommit(commit: CommitData): Promise<void> {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Batch-insert new blocks
      const newEntries = Array.from(commit.newBlocks);
      const BATCH_SIZE = 100;

      for (let i = 0; i < newEntries.length; i += BATCH_SIZE) {
        const batch = newEntries.slice(i, i + BATCH_SIZE);
        const values: unknown[] = [];
        const placeholders: string[] = [];

        for (let j = 0; j < batch.length; j++) {
          const [cid, bytes] = batch[j];
          const offset = j * 4;
          placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
          values.push(this.did, cid.toString(), Buffer.from(bytes), commit.rev);
        }

        await client.query(
          `INSERT INTO repo_blocks (community_did, cid, block_bytes, rev)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (community_did, cid) DO UPDATE SET block_bytes = EXCLUDED.block_bytes, rev = EXCLUDED.rev`,
          values
        );
      }

      // Remove old blocks
      const removedCids = commit.removedCids.toList();
      if (removedCids.length > 0) {
        const removedStrs = removedCids.map(c => c.toString());
        await client.query(
          'DELETE FROM repo_blocks WHERE community_did = $1 AND cid = ANY($2)',
          [this.did, removedStrs]
        );
      }

      // Update root
      const cidStr = commit.cid.toString();
      await client.query(
        `INSERT INTO repo_roots (did, root_cid, rev, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (did) DO UPDATE SET root_cid = $2, rev = $3, updated_at = CURRENT_TIMESTAMP`,
        [this.did, cidStr, commit.rev]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
