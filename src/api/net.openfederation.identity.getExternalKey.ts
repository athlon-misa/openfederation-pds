import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { EXTERNAL_KEY_COLLECTION } from '../identity/external-keys.js';

export default async function getExternalKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    const did = req.query.did as string;
    const rkey = req.query.rkey as string;

    if (!did || typeof did !== 'string' || !did.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'did parameter is required and must be a valid DID',
      });
      return;
    }

    if (!rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'rkey parameter is required',
      });
      return;
    }

    const result = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = $3`,
      [did, EXTERNAL_KEY_COLLECTION, rkey]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'KeyNotFound',
        message: 'No external key found for the given DID and rkey',
      });
      return;
    }

    const record = result.rows[0].record;

    res.status(200).json({
      uri: `at://${did}/${EXTERNAL_KEY_COLLECTION}/${rkey}`,
      rkey,
      type: record?.type,
      purpose: record?.purpose,
      publicKey: record?.publicKey,
      label: record?.label,
      createdAt: record?.createdAt,
    });
  } catch (error) {
    console.error('Error in getExternalKey:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to get external key',
    });
  }
}
