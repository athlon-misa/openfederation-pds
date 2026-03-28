import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { ROLE_COLLECTION, MEMBER_COLLECTION } from '../auth/permissions.js';

export default async function listRoles(req: AuthRequest, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;

    if (!communityDid || !communityDid.startsWith('did:')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'communityDid parameter is required' });
      return;
    }

    const roleResult = await query<{ rkey: string; record: any }>(
      `SELECT rkey, record FROM records_index
       WHERE community_did = $1 AND collection = $2
       ORDER BY rkey ASC`,
      [communityDid, ROLE_COLLECTION]
    );

    const memberCounts = await query<{ role_rkey: string; count: string }>(
      `SELECT record->>'roleRkey' as role_rkey, COUNT(*) as count
       FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'roleRkey' IS NOT NULL
       GROUP BY record->>'roleRkey'`,
      [communityDid, MEMBER_COLLECTION]
    );

    const countMap = new Map(memberCounts.rows.map(r => [r.role_rkey, parseInt(r.count)]));

    const oldStyleCounts = await query<{ role: string; count: string }>(
      `SELECT record->>'role' as role, COUNT(*) as count
       FROM records_index
       WHERE community_did = $1 AND collection = $2 AND record->>'roleRkey' IS NULL AND record->>'role' IS NOT NULL
       GROUP BY record->>'role'`,
      [communityDid, MEMBER_COLLECTION]
    );

    const oldCountMap = new Map(oldStyleCounts.rows.map(r => [r.role, parseInt(r.count)]));

    const roles = roleResult.rows.map(row => ({
      uri: `at://${communityDid}/${ROLE_COLLECTION}/${row.rkey}`,
      rkey: row.rkey,
      name: row.record?.name,
      description: row.record?.description,
      permissions: row.record?.permissions || [],
      memberCount: (countMap.get(row.rkey) || 0) + (oldCountMap.get(row.record?.name) || 0),
    }));

    res.status(200).json({ roles });
  } catch (error) {
    console.error('Error in listRoles:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list roles' });
  }
}
