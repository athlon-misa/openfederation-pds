import { Response } from 'express';
import crypto from 'crypto';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import {
  generateDEK,
  encryptClaim,
  createCommitment,
  wrapDEK,
} from '../attestation/encryption.js';
import { resolveDisplayFields } from '../community/display-projection.js';

const ATTESTATION_COLLECTION = 'net.openfederation.community.attestation';

async function upsertAttestationIndex(
  communityDid: string,
  rkey: string,
  subjectDid: string,
  subjectHandle: string,
  type: string,
  claim: unknown,
  issuedAt: string,
  expiresAt: string | null,
): Promise<void> {
  const display = await resolveDisplayFields(subjectDid, subjectHandle);
  await query(
    `INSERT INTO community_attestation_index
       (community_did, rkey, subject_did, subject_handle, subject_display_name, subject_avatar_url,
        type, claim, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (community_did, rkey) DO UPDATE SET
       subject_display_name = EXCLUDED.subject_display_name,
       subject_avatar_url   = EXCLUDED.subject_avatar_url,
       type                 = EXCLUDED.type,
       claim                = EXCLUDED.claim,
       issued_at            = EXCLUDED.issued_at,
       expires_at           = EXCLUDED.expires_at`,
    [
      communityDid, rkey, subjectDid, subjectHandle,
      display.displayName, display.avatarUrl,
      type, claim ? JSON.stringify(claim) : null,
      issuedAt, expiresAt,
    ],
  );
}
const VALID_TYPES = ['membership', 'role', 'credential'];
const MAX_CLAIM_SIZE_BYTES = 4096;
const MAX_CLAIM_DEPTH = 5;

/**
 * Returns the maximum nesting depth of a JSON value. Scalars/nulls are
 * depth 0. An object whose deepest property is a scalar is depth 1.
 */
function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    let max = 0;
    for (const v of value) max = Math.max(max, jsonDepth(v));
    return 1 + max;
  }
  let max = 0;
  for (const v of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, jsonDepth(v));
  }
  return 1 + max;
}

export default async function issueAttestation(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const {
      communityDid, subjectDid, subjectHandle, type, claim, expiresAt,
      visibility = 'public', accessPolicy,
    } = req.body;

    if (!communityDid || !subjectDid || !subjectHandle || !type || !claim) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, subjectDid, subjectHandle, type, claim',
      });
      return;
    }

    if (!VALID_TYPES.includes(type)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: `type must be one of: ${VALID_TYPES.join(', ')}`,
      });
      return;
    }

    if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'claim must be a JSON object',
      });
      return;
    }

    // Cap claim size and nesting depth to prevent storage inflation and
    // protect downstream serializers/renderers from pathological input.
    const claimJson = JSON.stringify(claim);
    if (claimJson.length > MAX_CLAIM_SIZE_BYTES) {
      res.status(400).json({
        error: 'PayloadTooLarge',
        message: `claim must not exceed ${MAX_CLAIM_SIZE_BYTES} bytes when serialized as JSON`,
      });
      return;
    }
    if (jsonDepth(claim) > MAX_CLAIM_DEPTH) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: `claim must not nest deeper than ${MAX_CLAIM_DEPTH} levels`,
      });
      return;
    }

    if (visibility !== 'public' && visibility !== 'private') {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'visibility must be "public" or "private"',
      });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext },
      res, communityDid, 'community.attestation.write'
    );
    if (!hasPermission) return;

    const memberResult = await query(
      'SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2',
      [communityDid, subjectDid]
    );

    if (memberResult.rows.length === 0) {
      res.status(404).json({
        error: 'NotMember',
        message: 'Subject is not a member of this community',
      });
      return;
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);
    const rkey = RepoEngine.generateTid();

    if (visibility === 'private') {
      // Generate DEK and encrypt claim
      const dek = generateDEK();
      const encrypted = encryptClaim(claim, dek);
      const commitment = createCommitment(claim);

      // Wrap DEK for issuer and subject
      const encryptedDekIssuer = await wrapDEK(dek);
      const encryptedDekSubject = await wrapDEK(dek);

      // Store encrypted record in repo (ciphertext replaces plaintext claim)
      const record = {
        subjectDid,
        subjectHandle,
        type,
        claim: {
          encrypted: true,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
        },
        visibility: 'private',
        commitment: commitment.hash,
        issuedAt: new Date().toISOString(),
        ...(expiresAt ? { expiresAt } : {}),
      };

      const result = await engine.putRecord(keypair, ATTESTATION_COLLECTION, rkey, record);

      // Store encryption metadata
      const encId = crypto.randomUUID();
      await query(
        `INSERT INTO attestation_encryption
         (id, community_did, rkey, visibility, encrypted_dek_issuer, encrypted_dek_subject, commitment_hash, access_policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          encId, communityDid, rkey, 'private',
          encryptedDekIssuer, encryptedDekSubject,
          commitment.hash,
          accessPolicy ? JSON.stringify(accessPolicy) : null,
        ]
      );

      await auditLog('community.issueAttestation', req.auth!.userId, communityDid, {
        subjectDid, type, rkey, visibility: 'private',
      });

      await upsertAttestationIndex(communityDid, rkey, subjectDid, subjectHandle, type, null, new Date().toISOString(), expiresAt ?? null);

      res.status(200).json({
        uri: result.uri,
        cid: result.cid,
        rkey,
        visibility: 'private',
        commitment: commitment.hash,
      });
    } else {
      // Public attestation: existing behavior unchanged
      const issuedAt = new Date().toISOString();
      const record = {
        subjectDid,
        subjectHandle,
        type,
        claim,
        issuedAt,
        ...(expiresAt ? { expiresAt } : {}),
      };

      const result = await engine.putRecord(keypair, ATTESTATION_COLLECTION, rkey, record);

      await auditLog('community.issueAttestation', req.auth!.userId, communityDid, {
        subjectDid, type, rkey,
      });

      await upsertAttestationIndex(communityDid, rkey, subjectDid, subjectHandle, type, claim, issuedAt, expiresAt ?? null);

      res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
    }
  } catch (error) {
    console.error('Error in issueAttestation:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to issue attestation' });
  }
}
