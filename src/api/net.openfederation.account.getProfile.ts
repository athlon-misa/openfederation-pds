import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';

const DEFAULT_COLLECTION = 'app.bsky.actor.profile';

export default async function getProfile(req: AuthRequest, res: Response): Promise<void> {
  try {
    const did = req.query.did as string;

    if (!did || !did.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'did parameter is required and must be a valid DID',
      });
      return;
    }

    const userResult = await query<{ handle: string }>(
      'SELECT handle FROM users WHERE did = $1',
      [did]
    );

    const profileResult = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = 'self'`,
      [did, DEFAULT_COLLECTION]
    );

    if (profileResult.rows.length === 0) {
      res.status(404).json({
        error: 'ProfileNotFound',
        message: 'No profile found for this DID',
      });
      return;
    }

    const customResult = await query<{ collection: string; record: any }>(
      `SELECT collection, record FROM records_index
       WHERE community_did = $1 AND collection LIKE '%.actor.profile' AND collection != $2 AND rkey = 'self'`,
      [did, DEFAULT_COLLECTION]
    );

    const customProfiles: Record<string, any> = {};
    for (const row of customResult.rows) {
      customProfiles[row.collection] = row.record;
    }

    res.status(200).json({
      did,
      handle: userResult.rows[0]?.handle || null,
      profile: profileResult.rows[0].record,
      ...(Object.keys(customProfiles).length > 0 ? { customProfiles } : {}),
    });
  } catch (error) {
    console.error('Error in getProfile:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get profile' });
  }
}
