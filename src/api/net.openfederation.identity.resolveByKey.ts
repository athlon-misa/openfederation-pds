import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { EXTERNAL_KEY_COLLECTION } from '../identity/external-keys.js';

export default async function resolveByKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    const publicKey = req.query.publicKey as string;
    const purpose = req.query.purpose as string | undefined;

    if (!publicKey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'publicKey parameter is required',
      });
      return;
    }

    let sql = `SELECT ri.community_did, ri.rkey, ri.record, u.handle
               FROM records_index ri
               JOIN users u ON u.did = ri.community_did
               WHERE ri.collection = $1 AND ri.record->>'publicKey' = $2`;
    const params: string[] = [EXTERNAL_KEY_COLLECTION, publicKey];

    if (purpose) {
      sql += ` AND ri.record->>'purpose' = $3`;
      params.push(purpose);
    }

    sql += ' LIMIT 1';

    const result = await query<{
      community_did: string;
      rkey: string;
      record: any;
      handle: string;
    }>(sql, params);

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'KeyNotFound',
        message: 'No identity found for the given public key',
      });
      return;
    }

    const row = result.rows[0];
    res.status(200).json({
      did: row.community_did,
      handle: row.handle,
      rkey: row.rkey,
      type: row.record?.type,
      purpose: row.record?.purpose,
      createdAt: row.record?.createdAt,
    });
  } catch (error) {
    console.error('Error in resolveByKey:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to resolve key',
    });
  }
}
