import { createHash } from 'node:crypto';
import { cidForRecord } from '@atproto/repo';
import type { OracleContext } from '../auth/oracle-guard.js';
import { query, withTransaction } from '../db/client.js';
import { HttpError } from '../xrpc/errors.js';
import type { GovernanceProof } from './chain-adapter.js';
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
  oracleName: string;
  operation: 'create' | 'put' | 'delete';
  proof: GovernanceProof;
  proofAuthorizationKey?: string;
  recordCid?: string;
  result?: unknown;
  rkey: string;
  status: 'pending' | 'applied';
  mutationFingerprint?: OracleMutationFingerprint;
  mutationFingerprintHash?: string;
}

interface AuditReservation {
  action: 'oracle.proofAuthorized' | 'oracle.proofApplied';
  existing: boolean;
  id: number;
  meta: OracleMutationAuditMeta;
  targetId: string;
}

function parseGovernanceProof(value: unknown): GovernanceProof {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || typeof (value as { chainId?: unknown }).chainId !== 'string'
    || !(value as { chainId: string }).chainId.trim()
    || typeof (value as { transactionHash?: unknown }).transactionHash !== 'string'
    || !(value as { transactionHash: string }).transactionHash.trim()
  ) {
    throw new HttpError(
      400,
      'InvalidRequest',
      'governanceProof with chainId and transactionHash is required for an Oracle-authorized on-chain mutation',
    );
  }

  return value as GovernanceProof;
}

/**
 * Require proof evidence only when the verified Oracle context is what made
 * an on-chain protected mutation eligible to proceed.
 */
export function prepareOracleMutationAudit(input: {
  governance: GovernanceResult;
  oracle: OracleContext | null;
  governanceProof: unknown;
}): OracleMutationAudit | null {
  if (input.governance.governanceModel !== 'on-chain' || !input.oracle) {
    return null;
  }

  return {
    oracle: input.oracle,
    proof: parseGovernanceProof(input.governanceProof),
  };
}

function hashJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function proofAuthorizationKey(audit: OracleMutationAudit): string {
  return hashJson([
    audit.oracle.credentialId,
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
  proofAuthorizationKey: string;
}): string {
  return hashJson([
    input.proofAuthorizationKey,
    input.mutationFingerprintHash,
  ]);
}

function fingerprintsMatch(
  reservation: AuditReservation,
  incoming: OracleMutationAuditMeta & {
    mutationFingerprint: OracleMutationFingerprint;
    mutationFingerprintHash: string;
  },
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
      && reservation.meta.authorizationKey === incoming.authorizationKey
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

async function reserveAudit(input: {
  audit: OracleMutationAudit;
  communityDid: string;
  meta: OracleMutationAuditMeta & { proofAuthorizationKey: string };
}): Promise<AuditReservation> {
  return withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [input.meta.proofAuthorizationKey],
    );

    const existing = await client.query<{
      action: 'oracle.proofAuthorized' | 'oracle.proofApplied';
      id: number;
      meta: OracleMutationAuditMeta;
      targetId: string;
    }>(
      `SELECT id, action, meta, target_id AS "targetId"
       FROM audit_log
       WHERE actor_id = $1
         AND action IN ('oracle.proofAuthorized', 'oracle.proofApplied')
         AND (
           meta->>'proofAuthorizationKey' = $2
           OR (
             meta->'proof'->>'chainId' = $3
             AND meta->'proof'->>'transactionHash' = $4
           )
         )
       ORDER BY id DESC
       LIMIT 1`,
      [
        input.audit.oracle.credentialId,
        input.meta.proofAuthorizationKey,
        input.audit.proof.chainId,
        input.audit.proof.transactionHash,
      ],
    );

    if (existing.rows[0]) {
      return { ...existing.rows[0], existing: true };
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

    return { ...inserted.rows[0], existing: false };
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
  const proofKey = proofAuthorizationKey(audit);
  const meta: OracleMutationAuditMeta & {
    mutationFingerprint: OracleMutationFingerprint;
    mutationFingerprintHash: string;
    proofAuthorizationKey: string;
  } = {
    action: input.action,
    authorizationKey: authorizationKey({
      mutationFingerprintHash: fingerprintHash,
      proofAuthorizationKey: proofKey,
    }),
    authorizedAt: new Date().toISOString(),
    collection: input.collection,
    mutationFingerprint,
    mutationFingerprintHash: fingerprintHash,
    oracleCommunityDid: audit.oracle.communityDid,
    oracleName: audit.oracle.name,
    operation: input.operation,
    proof: audit.proof,
    proofAuthorizationKey: proofKey,
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
    if (!fingerprintsMatch(reservation, meta)) {
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
