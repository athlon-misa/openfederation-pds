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

    // Read from the write-time projection index — single SELECT, no join needed
    let sql = `SELECT rkey, subject_did, subject_handle, subject_display_name, subject_avatar_url,
                      type, claim, issued_at, expires_at
               FROM community_attestation_index
               WHERE community_did = $1`;
    const params: (string | number)[] = [communityDid];
    let paramIdx = 2;

    if (subjectDid) {
      sql += ` AND subject_did = $${paramIdx}`;
      params.push(subjectDid);
      paramIdx++;
    }

    if (type) {
      sql += ` AND type = $${paramIdx}`;
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

    const result = await query<{
      rkey: string;
      subject_did: string;
      subject_handle: string;
      subject_display_name: string;
      subject_avatar_url: string | null;
      type: string;
      claim: unknown;
      issued_at: Date;
      expires_at: Date | null;
    }>(sql, params);

    let rows = result.rows;
    let nextCursor: string | undefined;
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      nextCursor = rows[rows.length - 1].rkey;
    }

    const attestations = rows.map(row => ({
      uri: `at://${communityDid}/${ATTESTATION_COLLECTION}/${row.rkey}`,
      rkey: row.rkey,
      subjectDid: row.subject_did,
      subjectHandle: row.subject_handle,
      subjectDisplayName: row.subject_display_name,
      subjectAvatarUrl: row.subject_avatar_url ?? null,
      type: row.type,
      claim: row.claim,
      issuedAt: new Date(row.issued_at).toISOString(),
      ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}),
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
