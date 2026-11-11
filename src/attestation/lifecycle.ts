import crypto from 'crypto';
import type { AuthContext } from '../auth/types.js';
import { query } from '../db/client.js';
import { unwrapDEK, decryptClaim } from './encryption.js';
import { watermarkJSON } from '../disclosure/watermark.js';
import { generateSessionKey, encryptWithSessionKey } from '../disclosure/session-keys.js';

const MAX_EXPIRY_MINUTES = 1440;
const DEFAULT_EXPIRY_MINUTES = 60;
const SESSION_TTL_MINUTES = 30;

export interface CreateViewingGrantInput {
  communityDid?: unknown;
  rkey?: unknown;
  grantedToDid?: unknown;
  expiresInMinutes?: unknown;
  grantedFields?: unknown;
}

export interface CreateViewingGrantResult {
  grantId: string;
  expiresAt: string;
}

export interface RedeemGrantInput {
  grantId?: unknown;
}

export interface RedeemGrantResult {
  sessionEncryptedPayload: unknown;
  sessionKey: string;
  expiresAt: string;
  watermarkId: string;
  /**
   * The salt of the attestation's public commitment, present only when the
   * grant covers the whole claim. With it the grantee can check that what
   * they were shown is what was attested: sha256(`salt:canonical(claim)`)
   * equals the published commitment hash.
   */
  commitmentSalt?: string;
}

export interface RevokeGrantInput {
  grantId?: unknown;
}

export class AttestationLifecycleError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'AttestationLifecycleError';
    this.code = code;
    this.status = status;
  }
}

export async function createViewingGrantLifecycle(
  caller: AuthContext,
  input: CreateViewingGrantInput,
): Promise<CreateViewingGrantResult> {
  const { communityDid, rkey, grantedToDid, expiresInMinutes, grantedFields } =
    validateCreateViewingGrantInput(input);

  await ensureGrantableAttestation(communityDid, rkey);
  const subjectDid = await getAttestationSubjectDid(communityDid, rkey);
  if (caller.did !== subjectDid) {
    throw new AttestationLifecycleError(
      'Forbidden',
      403,
      'Only the attestation subject can create viewing grants',
    );
  }

  const grantId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

  await query(
    `INSERT INTO viewing_grants
     (id, attestation_community_did, attestation_rkey, subject_did, granted_to_did, expires_at, granted_fields, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      grantId,
      communityDid,
      rkey,
      caller.did,
      grantedToDid,
      expiresAt.toISOString(),
      grantedFields ? JSON.stringify(grantedFields) : null,
      'active',
    ],
  );

  return {
    grantId,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function redeemGrantLifecycle(
  caller: AuthContext,
  input: RedeemGrantInput,
  context: { ipAddress?: string } = {},
): Promise<RedeemGrantResult> {
  const grantId = requireGrantId(input);
  const grant = await getViewingGrant(grantId);

  if (caller.did !== grant.granted_to_did) {
    throw new AttestationLifecycleError('Forbidden', 403, 'You are not the grantee of this viewing grant');
  }
  if (grant.status !== 'active') {
    throw new AttestationLifecycleError('GrantRevoked', 403, 'This viewing grant has been revoked');
  }
  if (grant.expired) {
    throw new AttestationLifecycleError('GrantExpired', 403, 'This viewing grant has expired');
  }

  const attestationRecord = await getAttestationRecord(grant.attestation_community_did, grant.attestation_rkey);
  const claim = attestationRecord.claim;
  let plainClaim: Record<string, unknown>;
  if (claim?.ciphertext && claim.iv && claim.authTag) {
    const encryptedDekIssuer = await getEncryptedDekIssuer(grant.attestation_community_did, grant.attestation_rkey);
    const dek = await unwrapDEK(encryptedDekIssuer);
    plainClaim = decryptClaim(claim.ciphertext, dek, claim.iv, claim.authTag);
  } else {
    // A public attestation in a private community: the claim is not encrypted.
    plainClaim = (claim ?? {}) as Record<string, unknown>;
  }
  const disclosedData = filterGrantedFields(plainClaim, grant.granted_fields);

  const watermarkId = crypto.randomUUID();
  const disclosedAt = new Date().toISOString();
  const watermarked = watermarkJSON(disclosedData, caller.did, watermarkId, disclosedAt);
  const { key: sessionKey, keyHash: sessionKeyHash } = generateSessionKey();
  const sessionEncryptedPayload = encryptWithSessionKey(JSON.stringify(watermarked), sessionKey);
  const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000);

  const sessionId = crypto.randomUUID();
  await query(
    `INSERT INTO disclosure_sessions
     (id, grant_id, requester_did, session_key_hash, watermark_id, access_count, expires_at, last_accessed_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, NOW())`,
    [sessionId, grantId, caller.did, sessionKeyHash, watermarkId, sessionExpiresAt.toISOString()],
  );

  await insertDisclosureAuditLog({
    grantId,
    communityDid: grant.attestation_community_did,
    rkey: grant.attestation_rkey,
    requesterDid: caller.did,
    action: 'redeem',
    watermarkId,
    ipAddress: context.ipAddress || '',
    metadata: { sessionId, grantedFields: grant.granted_fields },
  });

  // Only with a full disclosure. The commitment covers the whole claim, so a
  // partial view cannot be checked against it anyway, and the salt together
  // with some of the fields would let the grantee guess the rest.
  const fullDisclosure = grant.granted_fields === null || grant.granted_fields === undefined;
  const commitmentSalt = fullDisclosure
    ? await getCommitmentSalt(grant.attestation_community_did, grant.attestation_rkey)
    : null;

  return {
    sessionEncryptedPayload,
    sessionKey: sessionKey.toString('base64'),
    expiresAt: sessionExpiresAt.toISOString(),
    watermarkId,
    ...(commitmentSalt ? { commitmentSalt } : {}),
  };
}

export async function revokeGrantLifecycle(
  caller: AuthContext,
  input: RevokeGrantInput,
  context: { ipAddress?: string } = {},
): Promise<{ success: true }> {
  const grantId = requireGrantId(input);
  const grant = await getViewingGrant(grantId);

  if (caller.did !== grant.subject_did) {
    throw new AttestationLifecycleError('Forbidden', 403, 'Only the attestation subject can revoke viewing grants');
  }
  if (grant.status === 'revoked') {
    throw new AttestationLifecycleError('AlreadyRevoked', 400, 'This viewing grant is already revoked');
  }

  await query('UPDATE viewing_grants SET status = $1 WHERE id = $2', ['revoked', grantId]);
  await insertDisclosureAuditLog({
    grantId,
    communityDid: grant.attestation_community_did,
    rkey: grant.attestation_rkey,
    requesterDid: caller.did,
    action: 'revoke',
    ipAddress: context.ipAddress || '',
    metadata: { revokedBy: caller.did },
  });

  return { success: true };
}

function validateCreateViewingGrantInput(input: CreateViewingGrantInput): {
  communityDid: string;
  rkey: string;
  grantedToDid: string;
  expiresInMinutes: number;
  grantedFields?: unknown;
} {
  if (
    typeof input.communityDid !== 'string' ||
    typeof input.rkey !== 'string' ||
    typeof input.grantedToDid !== 'string' ||
    input.communityDid.length === 0 ||
    input.rkey.length === 0 ||
    input.grantedToDid.length === 0
  ) {
    throw new AttestationLifecycleError(
      'InvalidRequest',
      400,
      'Missing required fields: communityDid, rkey, grantedToDid',
    );
  }

  // `grantedFields` narrows what the grantee sees. Left out, the grant covers
  // the whole claim. Given, it has to be a list naming at least one field:
  // an empty list or a bare string used to be stored as-is and then read back
  // as "no restriction", disclosing everything to someone the subject meant
  // to show one field or none.
  if (input.grantedFields !== undefined && input.grantedFields !== null) {
    const fields = input.grantedFields;
    if (!Array.isArray(fields) || fields.length === 0 || fields.length > 100
      || !fields.every((f) => typeof f === 'string' && f.length > 0 && f.length <= 256)) {
      throw new AttestationLifecycleError(
        'InvalidRequest',
        400,
        'grantedFields must be a non-empty list of field names; omit it to grant the whole claim',
      );
    }
  }

  const expiresInMinutes = Math.min(
    Math.max(1, Number(input.expiresInMinutes) || DEFAULT_EXPIRY_MINUTES),
    MAX_EXPIRY_MINUTES,
  );

  return {
    communityDid: input.communityDid,
    rkey: input.rkey,
    grantedToDid: input.grantedToDid,
    expiresInMinutes,
    grantedFields: input.grantedFields,
  };
}

/**
 * A viewing grant only makes sense where not everyone can already look: a
 * private attestation, or any attestation in a private community.
 */
async function ensureGrantableAttestation(communityDid: string, rkey: string): Promise<void> {
  const grantable = await query(
    `SELECT 1 FROM attestation_encryption WHERE community_did = $1 AND rkey = $2 AND visibility = 'private'
     UNION ALL
     SELECT 1 FROM records_index r
       JOIN records_index s ON s.community_did = r.community_did
        AND s.collection = 'net.openfederation.community.settings' AND s.rkey = 'self'
     WHERE r.community_did = $1 AND r.collection = 'net.openfederation.community.attestation' AND r.rkey = $2
       AND s.record->>'visibility' = 'private'`,
    [communityDid, rkey],
  );

  if (grantable.rows.length === 0) {
    throw new AttestationLifecycleError('NotFound', 404, 'Private attestation not found');
  }
}

async function getAttestationSubjectDid(communityDid: string, rkey: string): Promise<string | undefined> {
  const recordResult = await query<{ record: { subjectDid?: string } }>(
    `SELECT record FROM records_index
     WHERE community_did = $1 AND collection = 'net.openfederation.community.attestation' AND rkey = $2`,
    [communityDid, rkey],
  );

  if (recordResult.rows.length === 0) {
    throw new AttestationLifecycleError('NotFound', 404, 'Attestation record not found');
  }

  return recordResult.rows[0].record.subjectDid;
}

function requireGrantId(input: RedeemGrantInput | RevokeGrantInput): string {
  if (typeof input.grantId !== 'string' || input.grantId.length === 0) {
    throw new AttestationLifecycleError('InvalidRequest', 400, 'Missing required field: grantId');
  }
  return input.grantId;
}

async function getViewingGrant(grantId: string): Promise<{
  id: string;
  attestation_community_did: string;
  attestation_rkey: string;
  subject_did: string;
  granted_to_did: string;
  expires_at: string;
  expired: boolean;
  granted_fields: string[] | null;
  status: string;
}> {
  const grantResult = await query<{
    id: string;
    attestation_community_did: string;
    attestation_rkey: string;
    subject_did: string;
    granted_to_did: string;
    expires_at: string;
    expired: boolean;
    granted_fields: string[] | null;
    status: string;
  }>(
    `SELECT id, attestation_community_did, attestation_rkey, subject_did,
            granted_to_did, expires_at, granted_fields, status,
            (expires_at < NOW()) AS expired
     FROM viewing_grants WHERE id = $1`,
    [grantId],
  );

  if (grantResult.rows.length === 0) {
    throw new AttestationLifecycleError('NotFound', 404, 'Viewing grant not found');
  }
  return grantResult.rows[0];
}

async function getEncryptedDekIssuer(communityDid: string, rkey: string): Promise<string> {
  const encResult = await query<{ encrypted_dek_issuer: string }>(
    'SELECT encrypted_dek_issuer FROM attestation_encryption WHERE community_did = $1 AND rkey = $2',
    [communityDid, rkey],
  );
  if (encResult.rows.length === 0) {
    throw new AttestationLifecycleError('NotFound', 404, 'Attestation encryption metadata not found');
  }
  return encResult.rows[0].encrypted_dek_issuer;
}

async function getAttestationRecord(communityDid: string, rkey: string): Promise<{
  claim?: { ciphertext?: string; iv?: string; authTag?: string };
  [key: string]: unknown;
}> {
  const recordResult = await query<{
    record: { claim?: { ciphertext?: string; iv?: string; authTag?: string }; [key: string]: unknown };
  }>(
    `SELECT record FROM records_index
     WHERE community_did = $1 AND collection = 'net.openfederation.community.attestation' AND rkey = $2`,
    [communityDid, rkey],
  );

  if (recordResult.rows.length === 0) {
    throw new AttestationLifecycleError('NotFound', 404, 'Attestation record not found');
  }
  return recordResult.rows[0].record;
}

async function getCommitmentSalt(communityDid: string, rkey: string): Promise<string | null> {
  const result = await query<{ commitment_salt: string | null }>(
    'SELECT commitment_salt FROM attestation_encryption WHERE community_did = $1 AND rkey = $2',
    [communityDid, rkey],
  );
  return result.rows[0]?.commitment_salt ?? null;
}

export function filterGrantedFields(
  decryptedClaim: Record<string, unknown>,
  grantedFields: unknown,
): Record<string, unknown> {
  // No restriction recorded: the whole claim. Anything else restricts, and a
  // restriction this code cannot read (not a list) discloses nothing rather
  // than everything.
  if (grantedFields === null || grantedFields === undefined) {
    return decryptedClaim;
  }
  if (!Array.isArray(grantedFields)) {
    return {};
  }

  const disclosedData: Record<string, unknown> = {};
  for (const field of grantedFields) {
    if (typeof field === 'string' && Object.hasOwn(decryptedClaim, field)) {
      disclosedData[field] = decryptedClaim[field];
    }
  }
  return disclosedData;
}

export async function insertDisclosureAuditLog(input: {
  grantId: string;
  communityDid: string;
  rkey: string;
  requesterDid: string;
  action: 'redeem' | 'revoke';
  watermarkId?: string;
  ipAddress: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  // Pseudonym rule: no network identifier is recorded for a pseudonym.
  const pseudonym = await query(
    `SELECT 1 FROM users WHERE did = $1 AND auth_type = 'pseudonym'`,
    [input.requesterDid],
  );
  const ipAddress = pseudonym.rows.length > 0 ? '' : input.ipAddress;
  await query(
    `INSERT INTO disclosure_audit_log
     (id, grant_id, attestation_community_did, attestation_rkey, requester_did, action, watermark_id, ip_address, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      crypto.randomUUID(),
      input.grantId,
      input.communityDid,
      input.rkey,
      input.requesterDid,
      input.action,
      input.watermarkId || null,
      ipAddress,
      JSON.stringify(input.metadata),
    ],
  );
}
