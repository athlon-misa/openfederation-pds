import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';

const DELEGATION_COLLECTION = 'net.openfederation.community.delegation';

export default async function getDelegation(req: AuthRequest, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;
    const memberDid = req.query.memberDid as string;

    if (!communityDid || !memberDid) {
      res.status(400).json({ error: 'InvalidRequest', message: 'communityDid and memberDid required' });
      return;
    }

    const delegatedTo = await query<{ record: Record<string, unknown> }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'delegatorDid' = $3`,
      [communityDid, DELEGATION_COLLECTION, memberDid]
    );

    const delegatedFrom = await query<{ record: Record<string, unknown> }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'delegateDid' = $3`,
      [communityDid, DELEGATION_COLLECTION, memberDid]
    );

    res.status(200).json({
      memberDid,
      delegatedTo: (delegatedTo.rows[0]?.record?.delegateDid as string) || null,
      delegatedFrom: delegatedFrom.rows.map(r => r.record?.delegatorDid as string).filter(Boolean),
    });
  } catch (error) {
    console.error('Error in getDelegation:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get delegation' });
  }
}
