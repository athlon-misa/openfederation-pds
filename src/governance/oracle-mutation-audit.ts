import { createHash } from 'node:crypto';
import { cidForRecord } from '@atproto/repo';
import type { OracleContext } from '../auth/oracle-guard.js';
import { query, withTransaction } from '../db/client.js';
import { HttpError } from '../xrpc/errors.js';
import type { GovernanceProof } from './attestor.js';
import type { GovernanceResult } from './enforcement.js';

export interface OracleMutationAudit {
  oracle: OracleContext;
  proof: GovernanceProof;
}

interface OracleMutationFingerprint {
  collection: string;
  operation: 'create' | 'put' | 'delete';
  recordCid?: string;
  repoDid: string;
  rkey: string;
}

interface OracleMutationAuditMeta {
  action: 'write' | 'delete';
  appliedAt?: string;
  authorizationKey: string;
  authorizedAt: string;
  collection: string;
  oracleCommunityDid: string;
  oracleCredentialId?: string;
  oracleName: string;
  operation: 'create' | 'put' | 'delete';
  proof: GovernanceProof;
  proofReservationKey?: string;
  recordCid?: string;
  result?: unknown;
  rkey: string;
  status: 'pending' | 'applied';
  mutationFingerprint?: OracleMutationFingerprint;
  mutationFingerprintHash?: string;
}

type CurrentOracleMutationAuditMeta = OracleMutationAuditMeta & {
  mutationFingerprint: OracleMutationFingerprint;
  mutationFingerprintHash: string;
  proofReservationKey: string;
};

interface AuditReservation {
  action: 'oracle.proofAuthorized' | 'oracle.proofApplied';
  conflictingFingerprint: boolean;
  existing: boolean;
  id: number;
  meta: OracleMutationAuditMeta;
  targetId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAIP_2_PATTERN = /^([a-z0-9-]{3,8}):([-_a-zA-Z0-9]{1,32})$/i;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const EVM_TRANSACTION_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

function invalidProof(message: string): never {
  throw new HttpError(400, 'InvalidRequest', message);
}

function canonicalizeCredentialId(value: string): string {
  const credentialId = value.trim();
  if (!UUID_PATTERN.test(credentialId)) {
    return invalidProof('Oracle credential ID is not a canonical UUID');
  }
  return credentialId.toLowerCase();
}

function canonicalizeCommunityDid(value: string): string {
  const communityDid = value.trim();
  if (
    !communityDid.startsWith('did:')
    || communityDid.length > 255
    || !VISIBLE_ASCII_PATTERN.test(communityDid)
  ) {
    return invalidProof('Oracle community DID is invalid');
  }
  return communityDid;
}

function canonicalizeChainId(
  value: string,
  allowLegacyAliases = false,
): string {
  const chainId = value.trim();
  if (chainId.length > 64) {
    return invalidProof('governanceProof.chainId exceeds 64 characters');
  }
  const match = CAIP_2_PATTERN.exec(chainId);
  if (!match) {
    return invalidProof('governanceProof.chainId must be a CAIP-2 identifier');
  }

  const namespace = match[1].toLowerCase();
  let reference = match[2];
  if (namespace === 'eip155') {
    if (!/^\d+$/.test(reference)) {
      return invalidProof('eip155 chain references must be decimal integers');
    }
    if (reference.length > 1 && reference.startsWith('0')) {
      if (!allowLegacyAliases) {
        return invalidProof('eip155 chain references must not contain leading zeros');
      }
      reference = BigInt(reference).toString();
    }
  }

  return `${namespace}:${reference}`;
}

function canonicalizeTransactionHash(
  value: string,
  chainId: string,
  allowLegacyAliases = false,
): string {
  const transactionHash = value.trim();
  if (
    !transactionHash
    || transactionHash.length > 255
    || !VISIBLE_ASCII_PATTERN.test(transactionHash)
  ) {
    return invalidProof(
      'governanceProof.transactionHash must contain 1-255 visible ASCII characters',
    );
  }

  if (chainId.startsWith('eip155:')) {
    if (EVM_TRANSACTION_HASH_PATTERN.test(transactionHash)) {
      return transactionHash.toLowerCase();
    }
    if (
      allowLegacyAliases
      && /^0x[0-9a-z-]+$/i.test(transactionHash)
    ) {
      return transactionHash.toLowerCase();
    }
    return invalidProof(
      'eip155 transaction hashes must be 0x-prefixed 32-byte hexadecimal values',
    );
  }

  return /^0x[0-9a-f]+$/i.test(transactionHash)
    ? transactionHash.toLowerCase()
    : transactionHash;
}

function canonicalizeProofFields(
  value: unknown,
  allowLegacyAliases = false,
): GovernanceProof {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || typeof (value as { chainId?: unknown }).chainId !== 'string'
    || typeof (value as { transactionHash?: unknown }).transactionHash !== 'string'
  ) {
    return invalidProof(
      'governanceProof with chainId and transactionHash is required for an Oracle-authorized on-chain mutation',
    );
  }

  const proof = value as GovernanceProof;
  const chainId = canonicalizeChainId(proof.chainId, allowLegacyAliases);
  return {
    ...proof,
    chainId,
    transactionHash: canonicalizeTransactionHash(
      proof.transactionHash,
      chainId,
      allowLegacyAliases,
    ),
  };
}

function parseGovernanceProof(
  value: unknown,
  credentialId: string,
): { credentialId: string; proof: GovernanceProof } {
  return {
    credentialId: canonicalizeCredentialId(credentialId),
    proof: canonicalizeProofFields(value),
  };
}

/**
 * Require proof evidence only when the verified Oracle context is what made
 * an on-chain protected mutation eligible to proceed.
 */
export function prepareOracleMutationAudit(input: {
  governance: GovernanceResult | null;
  oracle: OracleContext | null;
  governanceProof: unknown;
}): OracleMutationAudit | null {
  if (input.governance?.governanceModel !== 'on-chain' || !input.oracle) {
    return null;
  }

  const parsed = parseGovernanceProof(
    input.governanceProof,
    input.oracle.credentialId,
  );
  return {
    oracle: {
      ...input.oracle,
      credentialId: parsed.credentialId,
      communityDid: canonicalizeCommunityDid(input.oracle.communityDid),
    },
    proof: parsed.proof,
  };
}

function hashJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function proofReservationKey(audit: OracleMutationAudit): string {
  return hashJson([
    audit.oracle.communityDid,
    audit.proof.chainId,
    audit.proof.transactionHash,
  ]);
}

function mutationFingerprintHash(
  fingerprint: OracleMutationFingerprint,
): string {
  return hashJson([
    fingerprint.operation,
    fingerprint.repoDid,
    fingerprint.collection,
    fingerprint.rkey,
    fingerprint.recordCid ?? null,
  ]);
}

function authorizationKey(input: {
  mutationFingerprintHash: string;
  proofReservationKey: string;
}): string {
  return hashJson([
    input.proofReservationKey,
    input.mutationFingerprintHash,
  ]);
}

function fingerprintsMatch(
  reservation: AuditReservation,
  incoming: CurrentOracleMutationAuditMeta,
): boolean {
  const stored = reservation.meta.mutationFingerprint;

  if (stored) {
    return (
      stored.operation === incoming.mutationFingerprint.operation
      && stored.repoDid === incoming.mutationFingerprint.repoDid
      && stored.collection === incoming.mutationFingerprint.collection
      && stored.rkey === incoming.mutationFingerprint.rkey
      && (stored.recordCid ?? null)
        === (incoming.mutationFingerprint.recordCid ?? null)
      && reservation.meta.mutationFingerprintHash
        === incoming.mutationFingerprintHash
      && (
        !reservation.meta.proofReservationKey
        || reservation.meta.authorizationKey === incoming.authorizationKey
      )
    );
  }

  // Audit rows created before mutation fingerprints were introduced still
  // contain each fingerprint component at the top level. Derive their
  // fingerprint so an already-consumed proof cannot be rebound after upgrade.
  return (
    reservation.meta.operation === incoming.mutationFingerprint.operation
    && (reservation.meta.oracleCommunityDid || reservation.targetId)
      === incoming.mutationFingerprint.repoDid
    && reservation.meta.collection === incoming.mutationFingerprint.collection
    && reservation.meta.rkey === incoming.mutationFingerprint.rkey
    && (reservation.meta.recordCid ?? null)
      === (incoming.mutationFingerprint.recordCid ?? null)
  );
}

function reservationMatchesProof(
  reservation: AuditReservation,
  incoming: CurrentOracleMutationAuditMeta,
): boolean {
  if (
    reservation.meta.proofReservationKey
    === incoming.proofReservationKey
  ) {
    return true;
  }

  try {
    const storedProof = canonicalizeProofFields(
      reservation.meta.proof,
      true,
    );
    const storedCommunityDid = canonicalizeCommunityDid(
      reservation.meta.oracleCommunityDid || reservation.targetId,
    );
    return proofReservationKey({
      oracle: {
        credentialId: reservation.meta.oracleCredentialId || '',
        communityDid: storedCommunityDid,
        name: reservation.meta.oracleName,
      },
      proof: storedProof,
    }) === incoming.proofReservationKey;
  } catch {
    return false;
  }
}

async function reserveAudit(input: {
  audit: OracleMutationAudit;
  communityDid: string;
  meta: CurrentOracleMutationAuditMeta;
}): Promise<AuditReservation> {
  return withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [input.meta.proofReservationKey],
    );

    const candidates = await client.query<{
      action: 'oracle.proofAuthorized' | 'oracle.proofApplied';
      id: number;
      meta: OracleMutationAuditMeta;
      targetId: string;
    }>(
      `SELECT id, action, meta, target_id AS "targetId"
       FROM audit_log
       WHERE target_id = $1
         AND action IN ('oracle.proofAuthorized', 'oracle.proofApplied')
         AND (
           meta->>'proofReservationKey' = $2
           OR NOT (meta ? 'proofReservationKey')
         )
       ORDER BY id DESC`,
      [input.communityDid, input.meta.proofReservationKey],
    );

    const proofMatches = candidates.rows
      .map((row) => ({
        ...row,
        conflictingFingerprint: false,
        existing: true,
      }))
      .filter((row) => reservationMatchesProof(row, input.meta));
    if (proofMatches[0]) {
      return {
        ...proofMatches[0],
        conflictingFingerprint: proofMatches.some(
          (row) => !fingerprintsMatch(row, input.meta),
        ),
      };
    }

    const inserted = await client.query<{
      action: 'oracle.proofAuthorized';
      id: number;
      meta: OracleMutationAuditMeta;
      targetId: string;
    }>(
      `INSERT INTO audit_log (action, actor_id, target_id, meta)
       VALUES ('oracle.proofAuthorized', $1, $2, $3)
       RETURNING id, action, meta, target_id AS "targetId"`,
      [
        input.audit.oracle.credentialId,
        input.communityDid,
        JSON.stringify(input.meta),
      ],
    );

    return {
      ...inserted.rows[0],
      conflictingFingerprint: false,
      existing: false,
    };
  });
}

async function finalizeAudit(
  reservation: AuditReservation,
  result: unknown,
): Promise<void> {
  const appliedMeta: OracleMutationAuditMeta = {
    ...reservation.meta,
    status: 'applied',
    appliedAt: new Date().toISOString(),
    result: result ?? null,
  };
  const updated = await query(
    `UPDATE audit_log
     SET action = 'oracle.proofApplied',
         meta = $2
     WHERE id = $1
       AND action = 'oracle.proofAuthorized'
       AND meta->>'status' = 'pending'`,
    [reservation.id, JSON.stringify(appliedMeta)],
  );

  if (updated.rowCount !== 1) {
    throw new Error(`Failed to finalize Oracle mutation audit ${reservation.id}`);
  }
}

/**
 * Durably reserve the authoritative Oracle proof before mutation, then mark
 * that same row applied only after the repository write succeeds.
 *
 * A failed reservation prevents mutation. A failed finalization leaves the
 * durable pending row intact and propagates an error, so the mutation never
 * exists without audit evidence. Proof-level lookup detects every reuse, while
 * the fingerprint-bound authorization key permits only an exact applied retry
 * to return its stored result.
 */
export async function executeOracleGovernedMutation<T>(input: {
  audit: OracleMutationAudit | null;
  communityDid: string;
  collection: string;
  rkey: string;
  action: 'write' | 'delete';
  operation: 'create' | 'put' | 'delete';
  record?: Record<string, unknown>;
  mutate: () => Promise<T>;
}): Promise<T> {
  const audit = input.audit;
  if (!audit) {
    return input.mutate();
  }

  if (audit.oracle.communityDid !== input.communityDid) {
    throw new HttpError(
      403,
      'Forbidden',
      'Oracle credential does not authorize the target community',
    );
  }

  const recordCid = input.record
    ? (await cidForRecord(input.record)).toString()
    : undefined;
  const mutationFingerprint: OracleMutationFingerprint = {
    operation: input.operation,
    repoDid: input.communityDid,
    collection: input.collection,
    rkey: input.rkey,
    ...(recordCid ? { recordCid } : {}),
  };
  const fingerprintHash = mutationFingerprintHash(mutationFingerprint);
  const proofKey = proofReservationKey(audit);
  const meta: CurrentOracleMutationAuditMeta = {
    action: input.action,
    authorizationKey: authorizationKey({
      mutationFingerprintHash: fingerprintHash,
      proofReservationKey: proofKey,
    }),
    authorizedAt: new Date().toISOString(),
    collection: input.collection,
    mutationFingerprint,
    mutationFingerprintHash: fingerprintHash,
    oracleCommunityDid: audit.oracle.communityDid,
    oracleCredentialId: audit.oracle.credentialId,
    oracleName: audit.oracle.name,
    operation: input.operation,
    proof: audit.proof,
    proofReservationKey: proofKey,
    ...(recordCid ? { recordCid } : {}),
    rkey: input.rkey,
    status: 'pending',
  };
  const reservation = await reserveAudit({
    audit,
    communityDid: input.communityDid,
    meta,
  });

  if (reservation.existing) {
    if (
      reservation.conflictingFingerprint
      || !fingerprintsMatch(reservation, meta)
    ) {
      throw new HttpError(
        409,
        'InvalidRequest',
        'This Oracle authorization is already bound to a different repository mutation',
      );
    }
    if (
      reservation.action === 'oracle.proofApplied'
      && reservation.meta.status === 'applied'
    ) {
      return reservation.meta.result as T;
    }
    throw new HttpError(
      409,
      'InvalidRequest',
      'This Oracle authorization is pending reconciliation and cannot be applied again',
    );
  }

  const result = await input.mutate();
  await finalizeAudit(reservation, result);
  return result;
}
