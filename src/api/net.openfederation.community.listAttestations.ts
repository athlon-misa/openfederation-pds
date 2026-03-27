import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';

const ATTESTATION_COLLECTION = 'net.openfederation.community.attestation';

export default async function listAttestations(req: AuthRequest, res: Response): Promise<void> {
  try {
    const communityDid = req.query.communityDid as string;
    const subjectDid = req.query.subjectDid as string | undefined;
    const type = req.query.type as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const cursor = req.query.cursor as string | undefined;

    if (!communityDid || !communityDid.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'communityDid parameter is required and must be a valid DID',
      });
      return;
    }

    let sql = `SELECT rkey, record FROM records_index WHERE community_did = $1 AND collection = $2`;
    const params: (string | number)[] = [communityDid, ATTESTATION_COLLECTION];
    let paramIdx = 3;

    if (subjectDid) {
      sql += ` AND record->>'subjectDid' = $${paramIdx}`;
      params.push(subjectDid);
      paramIdx++;
    }

    if (type) {
      sql += ` AND record->>'type' = $${paramIdx}`;
      params.push(type);
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

    const attestations = rows.map(row => ({
      uri: `at://${communityDid}/${ATTESTATION_COLLECTION}/${row.rkey}`,
      rkey: row.rkey,
      subjectDid: row.record?.subjectDid,
      subjectHandle: row.record?.subjectHandle,
      type: row.record?.type,
      claim: row.record?.claim,
      issuedAt: row.record?.issuedAt,
      expiresAt: row.record?.expiresAt,
    }));

    res.status(200).json({
      attestations,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    });
  } catch (error) {
    console.error('Error in listAttestations:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list attestations' });
  }
}
