/**
 * Simplified Repository Engine for MVP
 *
 * This is a simplified version that stores records directly in SQL
 * without full ATProto MST implementation. This allows us to get
 * the MVP working quickly while maintaining the same API surface.
 *
 * TODO: Replace with full @atproto/repo implementation for production
 */

import { Secp256k1Keypair } from '@atproto/crypto';
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
    // Store initial records
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
    // Generate a simple CID (in production, this would be a real content-addressed identifier)
    const cid = this.generateSimpleCid(collection, rkey, record);
    const uri = `at://${this.communityDid}/${collection}/${rkey}`;

    // Store in database
    await query(
      `INSERT INTO records_index (community_did, collection, rkey, cid, record, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (community_did, collection, rkey)
       DO UPDATE SET cid = $4, record = $5, updated_at = CURRENT_TIMESTAMP`,
      [this.communityDid, collection, rkey, cid, JSON.stringify(record)]
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

    return { cid, uri };
  }

  /**
   * Get a record from the repository
   */
  async getRecord(collection: string, rkey: string): Promise<{ record: any; cid: string } | null> {
    const result = await query<{ record: string; cid: string }>(
      'SELECT record, cid FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
      [this.communityDid, collection, rkey]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      record: JSON.parse(result.rows[0].record),
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
    params.push(limit + 1); // Fetch one extra to determine if there's a next page

    const result = await query<{ rkey: string; record: string; cid: string }>(queryStr, params);

    const records = result.rows.slice(0, limit).map(row => ({
      rkey: row.rkey,
      record: JSON.parse(row.record),
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
   * Generate a simple CID-like identifier
   * In production, this would use proper content addressing
   */
  private generateSimpleCid(collection: string, rkey: string, record: any): string {
    const content = JSON.stringify({ collection, rkey, record });
    // Simple hash-like identifier (not cryptographically secure, just for MVP)
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `bafy${Math.abs(hash).toString(36)}${Date.now().toString(36)}`;
  }

  /**
   * Generate a new TID (timestamp identifier) for use as an rkey
   */
  static generateTid(): string {
    // Simple TID implementation: timestamp in base32 + random suffix
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    return `${timestamp.toString(32)}${random.toString(32).padStart(3, '0')}`;
  }
}
