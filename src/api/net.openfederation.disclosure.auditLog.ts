import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Query disclosure audit log entries for a given attestation.
 * Auth: must be the attestation subject or community owner.
 */
export default async function auditLog(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const auth = req.auth as AuthContext;

    const communityDid = (req.query.communityDid as string) || req.body?.communityDid;
    const rkey = (req.query.rkey as string) || req.body?.rkey;
    const limit = Math.min(
      Math.max(1, parseInt((req.query.limit as string) || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
      MAX_LIMIT
    );
    const cursor = (req.query.cursor as string) || undefined;

    if (!communityDid && !rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'At least one of communityDid or rkey is required',
      });
      return;
    }

    // Authorization: check if caller is the attestation subject or community owner
    let authorized = false;

    if (communityDid && rkey) {
      // Check if caller is attestation subject
      const recordResult = await query<{ record: { subjectDid?: string } }>(
        `SELECT record FROM records_index
         WHERE community_did = $1 AND collection = 'net.openfederation.community.attestation' AND rkey = $2`,
        [communityDid, rkey]
      );
      if (recordResult.rows.length > 0 && recordResult.rows[0].record.subjectDid === auth.did) {
        authorized = true;
      }

      // Check if caller is community owner
      if (!authorized) {
        const communityResult = await query<{ created_by: string }>(
          'SELECT created_by FROM communities WHERE did = $1',
          [communityDid]
        );
        if (communityResult.rows.length > 0 && communityResult.rows[0].created_by === auth.userId) {
          authorized = true;
        }
      }
    } else if (communityDid) {
      // If only communityDid, must be community owner
      const communityResult = await query<{ created_by: string }>(
        'SELECT created_by FROM communities WHERE did = $1',
        [communityDid]
      );
      if (communityResult.rows.length > 0 && communityResult.rows[0].created_by === auth.userId) {
        authorized = true;
      }
    }

    // Admins always have access
    if (auth.roles.includes('admin')) {
      authorized = true;
    }

    if (!authorized) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You are not authorized to view this audit log',
      });
      return;
    }

    // Build query
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (communityDid) {
      conditions.push(`attestation_community_did = $${paramIndex++}`);
      params.push(communityDid);
    }
    if (rkey) {
      conditions.push(`attestation_rkey = $${paramIndex++}`);
      params.push(rkey);
    }
    if (cursor) {
      conditions.push(`created_at < $${paramIndex++}`);
      params.push(cursor);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const result = await query<{
      id: string;
      grant_id: string | null;
      attestation_community_did: string;
      attestation_rkey: string;
      requester_did: string;
      action: string;
      watermark_id: string | null;
      ip_address: string | null;
      metadata: unknown;
      created_at: string;
    }>(
      `SELECT id, grant_id, attestation_community_did, attestation_rkey,
              requester_did, action, watermark_id, ip_address, metadata, created_at
       FROM disclosure_audit_log
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex}`,
      params
    );

    const entries = result.rows.map(row => ({
      id: row.id,
      grantId: row.grant_id,
      communityDid: row.attestation_community_did,
      rkey: row.attestation_rkey,
      requesterDid: row.requester_did,
      action: row.action,
      watermarkId: row.watermark_id,
      ipAddress: row.ip_address,
      metadata: row.metadata,
      createdAt: row.created_at,
    }));

    const nextCursor = entries.length === limit
      ? entries[entries.length - 1].createdAt
      : undefined;

    res.status(200).json({
      entries,
      cursor: nextCursor,
    });
  } catch (error) {
    console.error('Error in disclosure auditLog:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to query disclosure audit log' });
  }
}
