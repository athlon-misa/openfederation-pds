import { Response } from 'express';
import crypto from 'crypto';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { unwrapDEK, decryptClaim } from '../attestation/encryption.js';
import { watermarkJSON } from '../disclosure/watermark.js';
import { generateSessionKey, encryptWithSessionKey } from '../disclosure/session-keys.js';

const SESSION_TTL_MINUTES = 30;

/**
 * Redeem a viewing grant to access a private attestation.
 *
 * Flow: validate grant -> unwrap DEK -> decrypt attestation -> watermark ->
 *       generate session key -> re-encrypt with session key -> return.
 */
export default async function redeemGrant(req: AuthRequest, res: Response): Promise<void> {
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

    // Fetch and validate the grant
    const grantResult = await query<{
      id: string;
      attestation_community_did: string;
      attestation_rkey: string;
      subject_did: string;
      granted_to_did: string;
      expires_at: string;
      granted_fields: string[] | null;
      status: string;
    }>(
      `SELECT id, attestation_community_did, attestation_rkey, subject_did,
              granted_to_did, expires_at, granted_fields, status
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

    // Check requester DID matches grantee
    if (auth.did !== grant.granted_to_did) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You are not the grantee of this viewing grant',
      });
      return;
    }

    // Check grant is active
    if (grant.status !== 'active') {
      res.status(403).json({
        error: 'GrantRevoked',
        message: 'This viewing grant has been revoked',
      });
      return;
    }

    // Check grant has not expired
    if (new Date(grant.expires_at) < new Date()) {
      res.status(403).json({
        error: 'GrantExpired',
        message: 'This viewing grant has expired',
      });
      return;
    }

    // Retrieve encryption metadata
    const encResult = await query<{
      encrypted_dek_issuer: string;
    }>(
      'SELECT encrypted_dek_issuer FROM attestation_encryption WHERE community_did = $1 AND rkey = $2',
      [grant.attestation_community_did, grant.attestation_rkey]
    );

    if (encResult.rows.length === 0) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Attestation encryption metadata not found',
      });
      return;
    }

    // Retrieve the attestation record
    const recordResult = await query<{
      record: { claim?: { ciphertext?: string; iv?: string; authTag?: string }; [key: string]: unknown };
    }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.attestation' AND rkey = $2`,
      [grant.attestation_community_did, grant.attestation_rkey]
    );

    if (recordResult.rows.length === 0) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Attestation record not found',
      });
      return;
    }

    const attestationRecord = recordResult.rows[0].record;
    const claim = attestationRecord.claim;

    if (!claim || !claim.ciphertext || !claim.iv || !claim.authTag) {
      res.status(500).json({
        error: 'InternalServerError',
        message: 'Attestation missing encrypted claim data',
      });
      return;
    }

    // Unwrap DEK and decrypt the claim
    const dek = await unwrapDEK(encResult.rows[0].encrypted_dek_issuer);
    const decryptedClaim = decryptClaim(claim.ciphertext, dek, claim.iv, claim.authTag);

    // Apply field filtering if granted_fields is specified
    let disclosedData: Record<string, unknown> = decryptedClaim;
    if (grant.granted_fields && Array.isArray(grant.granted_fields) && grant.granted_fields.length > 0) {
      disclosedData = {};
      for (const field of grant.granted_fields) {
        if (field in decryptedClaim) {
          disclosedData[field] = decryptedClaim[field];
        }
      }
    }

    // Watermark the disclosed data
    const watermarkId = crypto.randomUUID();
    const disclosedAt = new Date().toISOString();
    const watermarked = watermarkJSON(disclosedData, auth.did, watermarkId, disclosedAt);

    // Generate session key and encrypt watermarked content
    const { key: sessionKey, keyHash: sessionKeyHash } = generateSessionKey();
    const sessionEncryptedPayload = encryptWithSessionKey(JSON.stringify(watermarked), sessionKey);

    const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000);

    // Create disclosure session record
    const sessionId = crypto.randomUUID();
    await query(
      `INSERT INTO disclosure_sessions
       (id, grant_id, requester_did, session_key_hash, watermark_id, access_count, expires_at, last_accessed_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, NOW())`,
      [sessionId, grantId, auth.did, sessionKeyHash, watermarkId, sessionExpiresAt.toISOString()]
    );

    // Log to disclosure audit
    const auditId = crypto.randomUUID();
    const ipAddress = (req.ip || req.socket?.remoteAddress || '') as string;
    await query(
      `INSERT INTO disclosure_audit_log
       (id, grant_id, attestation_community_did, attestation_rkey, requester_did, action, watermark_id, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        auditId, grantId, grant.attestation_community_did, grant.attestation_rkey,
        auth.did, 'redeem', watermarkId, ipAddress,
        JSON.stringify({ sessionId, grantedFields: grant.granted_fields }),
      ]
    );

    res.status(200).json({
      sessionEncryptedPayload,
      sessionKey: sessionKey.toString('base64'),
      expiresAt: sessionExpiresAt.toISOString(),
      watermarkId,
    });
  } catch (error) {
    console.error('Error in redeemGrant:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to redeem viewing grant' });
  }
}
