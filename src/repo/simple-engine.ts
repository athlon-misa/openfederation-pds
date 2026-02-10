/**
 * Simplified Repository Engine for MVP
 *
 * Uses proper ATProto TID generation and content-addressed CIDs
 * for protocol compatibility. Records are stored in SQL with JSONB.
 *
 * TODO: Replace with full @atproto/repo MST implementation for production
 */

import { TID } from '@atproto/common-web';
import { cidForRecord } from '@atproto/repo';
import { query } from '../db/client.js';

/**
 * Simplified Repository Engine
 */
export class SimpleRepoEngine {
  private communityDid: string;

  constructor(communityDid: string) {
    this.communityDid = communityDid;
  }

  /**
   * Initialize a new repository for a community
   */
  async createRepo(
    signingKeyBase64: string,
    initialRecords?: Array<{ collection: string; rkey: string; record: any }>
  ): Promise<void> {
    if (initialRecords) {
      for (const r of initialRecords) {
        await this.putRecord(signingKeyBase64, r.collection, r.rkey, r.record);
      }
    }
  }

  /**
   * Put (create or update) a record in the repository
   */
  async putRecord(
    signingKeyBase64: string,
    collection: string,
    rkey: string,
    record: any
  ): Promise<{ cid: string; uri: string }> {
    // Generate a proper content-addressed CID using ATProto's cidForRecord
    const cid = await cidForRecord(record);
    const cidStr = cid.toString();
    const uri = `at://${this.communityDid}/${collection}/${rkey}`;

    // Store in database
    await query(
      `INSERT INTO records_index (community_did, collection, rkey, cid, record, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (community_did, collection, rkey)
       DO UPDATE SET cid = $4, record = $5, updated_at = CURRENT_TIMESTAMP`,
      [this.communityDid, collection, rkey, cidStr, record]
    );

    // If this is a member record, also update the members_unique table
    if (collection === 'net.openfederation.community.member' && record.did) {
      await query(
        `INSERT INTO members_unique (community_did, member_did, record_rkey)
         VALUES ($1, $2, $3)
         ON CONFLICT (community_did, member_did) DO NOTHING`,
        [this.communityDid, record.did, rkey]
      );
    }

    return { cid: cidStr, uri };
  }

  /**
   * Get a record from the repository
   */
  async getRecord(collection: string, rkey: string): Promise<{ record: any; cid: string } | null> {
    const result = await query<{ record: any; cid: string }>(
      'SELECT record, cid FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
      [this.communityDid, collection, rkey]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      record: result.rows[0].record,
      cid: result.rows[0].cid,
    };
  }

  /**
   * List records in a collection
   */
  async listRecords(
    collection: string,
    limit: number = 50,
    cursor?: string
  ): Promise<{ records: Array<{ rkey: string; record: any; cid: string }>; cursor?: string }> {
    let queryStr = `
      SELECT rkey, record, cid
      FROM records_index
      WHERE community_did = $1 AND collection = $2
    `;
    const params: any[] = [this.communityDid, collection];

    if (cursor) {
      queryStr += ' AND rkey > $3';
      params.push(cursor);
    }

    queryStr += ' ORDER BY rkey ASC LIMIT $' + (params.length + 1);
    params.push(limit + 1);

    const result = await query<{ rkey: string; record: any; cid: string }>(queryStr, params);

    const records = result.rows.slice(0, limit).map(row => ({
      rkey: row.rkey,
      record: row.record,
      cid: row.cid,
    }));

    const hasMore = result.rows.length > limit;
    const nextCursor = hasMore ? records[records.length - 1].rkey : undefined;

    return {
      records,
      cursor: nextCursor,
    };
  }

  /**
   * Export all records in the repository as a flat list.
   * Used for community export / backup (AT Protocol "free to go" principle).
   */
  async exportAllRecords(): Promise<Array<{ collection: string; rkey: string; cid: string; record: any }>> {
    const result = await query<{ collection: string; rkey: string; cid: string; record: any }>(
      'SELECT collection, rkey, cid, record FROM records_index WHERE community_did = $1 ORDER BY collection, rkey',
      [this.communityDid]
    );
    return result.rows;
  }

  /**
   * Delete a record from the repository
   */
  async deleteRecord(
    signingKeyBase64: string,
    collection: string,
    rkey: string
  ): Promise<void> {
    await query(
      'DELETE FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
      [this.communityDid, collection, rkey]
    );
  }

  /**
   * Generate a new TID using ATProto's standard TID algorithm.
   * TIDs are timestamp-based, monotonically increasing, base32-sortable identifiers.
   */
  static generateTid(): string {
    return TID.nextStr();
  }
}
