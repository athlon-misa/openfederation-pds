import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { unwrapDEK, wrapDEK } from '../attestation/encryption.js';

/**
 * Request disclosure of a private attestation.
 * Evaluates access policy to determine if the requester can see the decrypted content.
 * If authorized, re-wraps the DEK for the requester and returns encrypted data.
 */
export default async function requestDisclosure(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const auth = req.auth as AuthContext;

    const { communityDid, rkey, purpose } = req.body;

    if (!communityDid || !rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, rkey',
      });
      return;
    }

    // Check if attestation exists and has encryption metadata
    const encResult = await query<{
      id: string;
      visibility: string;
      encrypted_dek_issuer: string;
      encrypted_dek_subject: string;
      access_policy: unknown;
    }>(
      'SELECT id, visibility, encrypted_dek_issuer, encrypted_dek_subject, access_policy FROM attestation_encryption WHERE community_did = $1 AND rkey = $2',
      [communityDid, rkey]
    );

    if (encResult.rows.length === 0) {
      // No encryption record means this is a public attestation
      res.status(400).json({
        error: 'AttestationPublic',
        message: 'Attestation is public, no disclosure needed',
      });
      return;
    }

    const encRow = encResult.rows[0];

    if (encRow.visibility !== 'private') {
      res.status(400).json({
        error: 'AttestationPublic',
        message: 'Attestation is public, no disclosure needed',
      });
      return;
    }

    // Get the attestation record to find issuer (communityDid) and subject
    const recordResult = await query<{
      record: { subjectDid?: string; claim?: { ciphertext?: string; iv?: string; authTag?: string } };
    }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.attestation' AND rkey = $2`,
      [communityDid, rkey]
    );

    if (recordResult.rows.length === 0) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Attestation not found',
      });
      return;
    }

    const attestationRecord = recordResult.rows[0].record;
    const subjectDid = attestationRecord.subjectDid;

    // Check authorization: issuer or subject always have access
    const isIssuer = auth.roles.includes('admin');
    const isSubject = auth.did === subjectDid;

    // Check community ownership for issuer access
    const communityResult = await query<{ created_by: string }>(
      'SELECT created_by FROM communities WHERE did = $1',
      [communityDid]
    );
    const isCommunityOwner = communityResult.rows.length > 0 && communityResult.rows[0].created_by === auth.userId;

    let authorized = isIssuer || isSubject || isCommunityOwner;

    // If not already authorized, evaluate access policy
    if (!authorized && encRow.access_policy) {
      const policy = encRow.access_policy as { type: string; dids?: string[]; communityDid?: string };

      if (policy.type === 'did-allowlist' && Array.isArray(policy.dids)) {
        authorized = policy.dids.includes(auth.did);
      } else if (policy.type === 'community-member' && policy.communityDid) {
        const memberCheck = await query(
          'SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2',
          [policy.communityDid, auth.did]
        );
        authorized = memberCheck.rows.length > 0;
      }
    }

    // Also check viewing grants
    if (!authorized) {
      const grantCheck = await query(
        `SELECT 1 FROM viewing_grants
         WHERE attestation_community_did = $1 AND attestation_rkey = $2
         AND granted_to_did = $3 AND status = 'active' AND expires_at > NOW()`,
        [communityDid, rkey, auth.did]
      );
      authorized = grantCheck.rows.length > 0;
    }

    if (!authorized) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You are not authorized to access this private attestation',
      });
      return;
    }

    // Unwrap DEK and re-wrap for requester
    const dek = await unwrapDEK(encRow.encrypted_dek_issuer);
    const encryptedDEKForRequester = await wrapDEK(dek);

    const claim = attestationRecord.claim || {};

    res.status(200).json({
      encryptedDEK: encryptedDEKForRequester,
      ciphertext: claim.ciphertext || '',
      iv: claim.iv || '',
      authTag: claim.authTag || '',
    });
  } catch (error) {
    console.error('Error in requestDisclosure:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to process disclosure request' });
  }
}
