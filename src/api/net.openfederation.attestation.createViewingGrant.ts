import { Response } from 'express';
import crypto from 'crypto';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';

const MAX_EXPIRY_MINUTES = 1440; // 24 hours
const DEFAULT_EXPIRY_MINUTES = 60;

/**
 * Create a time-limited viewing grant for a private attestation.
 * Only the attestation subject can create grants.
 */
export default async function createViewingGrant(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const auth = req.auth as AuthContext;

    const {
      communityDid, rkey, grantedToDid,
      expiresInMinutes = DEFAULT_EXPIRY_MINUTES,
      grantedFields,
    } = req.body;

    if (!communityDid || !rkey || !grantedToDid) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, rkey, grantedToDid',
      });
      return;
    }

    const expMinutes = Math.min(Math.max(1, Number(expiresInMinutes) || DEFAULT_EXPIRY_MINUTES), MAX_EXPIRY_MINUTES);

    // Verify attestation exists and is private
    const encResult = await query(
      'SELECT 1 FROM attestation_encryption WHERE community_did = $1 AND rkey = $2 AND visibility = $3',
      [communityDid, rkey, 'private']
    );

    if (encResult.rows.length === 0) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Private attestation not found',
      });
      return;
    }

    // Check that the caller is the attestation subject
    const recordResult = await query<{
      record: { subjectDid?: string };
    }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.attestation' AND rkey = $2`,
      [communityDid, rkey]
    );

    if (recordResult.rows.length === 0) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Attestation record not found',
      });
      return;
    }

    const subjectDid = recordResult.rows[0].record.subjectDid;
    if (auth.did !== subjectDid) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only the attestation subject can create viewing grants',
      });
      return;
    }

    const grantId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + expMinutes * 60 * 1000);

    await query(
      `INSERT INTO viewing_grants
       (id, attestation_community_did, attestation_rkey, subject_did, granted_to_did, expires_at, granted_fields, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        grantId, communityDid, rkey, auth.did, grantedToDid,
        expiresAt.toISOString(),
        grantedFields ? JSON.stringify(grantedFields) : null,
        'active',
      ]
    );

    res.status(200).json({
      grantId,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error('Error in createViewingGrant:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create viewing grant' });
  }
}
