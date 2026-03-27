import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { EXTERNAL_KEY_COLLECTION } from '../identity/external-keys.js';

export default async function listExternalKeys(req: AuthRequest, res: Response): Promise<void> {
  try {
    const did = req.query.did as string;
    const purpose = req.query.purpose as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const cursor = req.query.cursor as string | undefined;

    if (!did || typeof did !== 'string' || !did.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'did parameter is required and must be a valid DID',
      });
      return;
    }

    let sql = `SELECT rkey, record FROM records_index
               WHERE community_did = $1 AND collection = $2`;
    const params: (string | number)[] = [did, EXTERNAL_KEY_COLLECTION];
    let paramIdx = 3;

    if (purpose) {
      sql += ` AND record->>'purpose' = $${paramIdx}`;
      params.push(purpose);
      paramIdx++;
    }

    if (cursor) {
      sql += ` AND rkey > $${paramIdx}`;
      params.push(cursor);
      paramIdx++;
    }

    sql += ` ORDER BY rkey ASC LIMIT $${paramIdx}`;
    params.push(limit + 1);

    const result = await query<{ rkey: string; record: any }>(sql, params);
    let rows = result.rows;

    let nextCursor: string | undefined;
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      nextCursor = rows[rows.length - 1].rkey;
    }

    const keys = rows.map(row => ({
      uri: `at://${did}/${EXTERNAL_KEY_COLLECTION}/${row.rkey}`,
      rkey: row.rkey,
      type: row.record?.type,
      purpose: row.record?.purpose,
      publicKey: row.record?.publicKey,
      label: row.record?.label,
      createdAt: row.record?.createdAt,
    }));

    res.status(200).json({
      keys,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    });
  } catch (error) {
    console.error('Error in listExternalKeys:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to list external keys',
    });
  }
}
