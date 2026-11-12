import { Response } from 'express';
import type { AuthRequest } from '../../../auth/types.js';
import { requireAuth, requireRole } from '../../../auth/guards.js';
import { query } from '../../../db/client.js';

export default async function listOracleCredentials(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireRole(req, res, ['admin'])) return;

    const communityDid = req.query.communityDid as string | undefined;

    let sql = `SELECT id, community_did, key_prefix, name, status, proofs_submitted, last_used_at, created_at
               FROM oracle_credentials`;
    const params: string[] = [];

    if (communityDid) {
      sql += ' WHERE community_did = $1';
      params.push(communityDid);
    }

    sql += ' ORDER BY created_at DESC';

    const result = await query<{
      id: string; community_did: string; key_prefix: string; name: string;
      status: string; proofs_submitted: number; last_used_at: Date | null; created_at: Date;
    }>(sql, params);

    // Postgres hands timestamps back as Date objects; the lexicon says
    // datetime strings, and a never-used credential has no lastUsedAt at all.
    const credentials = result.rows.map(row => ({
      id: row.id,
      communityDid: row.community_did,
      keyPrefix: row.key_prefix,
      name: row.name,
      status: row.status,
      proofsSubmitted: row.proofs_submitted,
      ...(row.last_used_at ? { lastUsedAt: new Date(row.last_used_at).toISOString() } : {}),
      createdAt: new Date(row.created_at).toISOString(),
    }));

    res.status(200).json({ credentials });
  } catch (error) {
    console.error('Error listing Oracle credentials:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list credentials.' });
  }
}
