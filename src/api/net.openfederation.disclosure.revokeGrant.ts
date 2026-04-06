import { Response } from 'express';
import crypto from 'crypto';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';

/**
 * Revoke a viewing grant. Only the attestation subject (grant creator) can revoke.
 */
export default async function revokeGrant(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const auth = req.auth as AuthContext;

    const { grantId } = req.body;

    if (!grantId) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required field: grantId',
      });
      return;
    }

    const grantResult = await query<{
      id: string;
      attestation_community_did: string;
      attestation_rkey: string;
      subject_did: string;
      status: string;
    }>(
      'SELECT id, attestation_community_did, attestation_rkey, subject_did, status FROM viewing_grants WHERE id = $1',
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

    // Only the subject (grant creator) can revoke
    if (auth.did !== grant.subject_did) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only the attestation subject can revoke viewing grants',
      });
      return;
    }

    if (grant.status === 'revoked') {
      res.status(400).json({
        error: 'AlreadyRevoked',
        message: 'This viewing grant is already revoked',
      });
      return;
    }

    // Set grant status to revoked
    await query(
      `UPDATE viewing_grants SET status = 'revoked' WHERE id = $1`,
      [grantId]
    );

    // Log to disclosure audit
    const auditId = crypto.randomUUID();
    const ipAddress = (req.ip || req.socket?.remoteAddress || '') as string;
    await query(
      `INSERT INTO disclosure_audit_log
       (id, grant_id, attestation_community_did, attestation_rkey, requester_did, action, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        auditId, grantId, grant.attestation_community_did, grant.attestation_rkey,
        auth.did, 'revoke', ipAddress,
        JSON.stringify({ revokedBy: auth.did }),
      ]
    );

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in revokeGrant:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to revoke viewing grant' });
  }
}
