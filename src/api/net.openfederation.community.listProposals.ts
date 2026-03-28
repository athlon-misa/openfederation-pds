import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';

const PROPOSAL_COLLECTION = 'net.openfederation.community.proposal';

export default async function listProposals(req: AuthRequest, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;
    const status = req.query.status as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const cursor = req.query.cursor as string | undefined;

    if (!communityDid || !communityDid.startsWith('did:')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'communityDid parameter is required' });
      return;
    }

    let sql = `SELECT rkey, record FROM records_index WHERE community_did = $1 AND collection = $2`;
    const params: (string | number)[] = [communityDid, PROPOSAL_COLLECTION];
    let paramIdx = 3;

    if (status) {
      sql += ` AND record->>'status' = $${paramIdx}`;
      params.push(status);
      paramIdx++;
    }

    if (cursor) {
      sql += ` AND rkey > $${paramIdx}`;
      params.push(cursor);
      paramIdx++;
    }

    sql += ` ORDER BY rkey DESC LIMIT $${paramIdx}`;
    params.push(limit + 1);

    const result = await query<{ rkey: string; record: any }>(sql, params);
    let rows = result.rows;

    let nextCursor: string | undefined;
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      nextCursor = rows[rows.length - 1].rkey;
    }

    const proposals = rows.map(row => ({
      uri: `at://${communityDid}/${PROPOSAL_COLLECTION}/${row.rkey}`,
      rkey: row.rkey,
      ...row.record,
    }));

    res.status(200).json({
      proposals,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    });
  } catch (error) {
    console.error('Error in listProposals:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list proposals' });
  }
}
