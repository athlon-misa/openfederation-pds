import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';

/**
 * Get the status of a viewing grant including access statistics.
 * Auth: must be the grant subject (creator) or the grantee.
 */
export default async function grantStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const auth = req.auth as AuthContext;

    const grantId = (req.query.grantId as string) || req.body?.grantId;

    if (!grantId) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required parameter: grantId',
      });
      return;
    }

    const grantResult = await query<{
      id: string;
      subject_did: string;
      granted_to_did: string;
      status: string;
      expires_at: string;
      created_at: string;
    }>(
      `SELECT id, subject_did, granted_to_did, status, expires_at, created_at
       FROM viewing_grants WHERE id = $1`,
      [grantId]
    );

    if (grantResult.rows.length === 0) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Viewing grant not found',
      });
      return;
    }

    const grant = grantResult.rows[0];

    // Auth check: must be subject or grantee
    if (auth.did !== grant.subject_did && auth.did !== grant.granted_to_did) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You are not authorized to view this grant status',
      });
      return;
    }

    // Aggregate access info from disclosure sessions
    const sessionResult = await query<{
      total_access_count: string;
      last_accessed: string | null;
    }>(
      `SELECT COALESCE(SUM(access_count), 0) AS total_access_count,
              MAX(last_accessed_at) AS last_accessed
       FROM disclosure_sessions WHERE grant_id = $1`,
      [grantId]
    );

    const stats = sessionResult.rows[0];

    const active = grant.status === 'active' && new Date(grant.expires_at) > new Date();

    res.status(200).json({
      active,
      expiresAt: grant.expires_at,
      accessCount: parseInt(stats.total_access_count, 10) || 0,
      lastAccessedAt: stats.last_accessed || null,
      createdAt: grant.created_at,
    });
  } catch (error) {
    console.error('Error in grantStatus:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get grant status' });
  }
}
