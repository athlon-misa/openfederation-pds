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
  recordCid?: string;
  result?: unknown;
  rkey: string;
  status: 'pending' | 'applied';
}

interface AuditReservation {
  action: 'oracle.proofAuthorized' | 'oracle.proofApplied';
  existing: boolean;
  id: number;
  meta: OracleMutationAuditMeta;
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

function authorizationKey(input: {
  audit: OracleMutationAudit;
  communityDid: string;
  collection: string;
  action: 'write' | 'delete';
}): string {
  return createHash('sha256')
    .update(JSON.stringify([
      input.audit.oracle.credentialId,
      input.communityDid,
      input.collection,
      input.action,
      input.audit.proof.chainId,
      input.audit.proof.transactionHash,
    ]))
    .digest('hex');
}

async function reserveAudit(input: {
  audit: OracleMutationAudit;
  communityDid: string;
  meta: OracleMutationAuditMeta;
}): Promise<AuditReservation> {
  return withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [input.meta.authorizationKey],
    );

    const existing = await client.query<{
      action: 'oracle.proofAuthorized' | 'oracle.proofApplied';
      id: number;
      meta: OracleMutationAuditMeta;
    }>(
      `SELECT id, action, meta
       FROM audit_log
       WHERE actor_id = $1
         AND target_id = $2
         AND action IN ('oracle.proofAuthorized', 'oracle.proofApplied')
         AND meta->>'authorizationKey' = $3
       ORDER BY id DESC
       LIMIT 1`,
      [
        input.audit.oracle.credentialId,
        input.communityDid,
        input.meta.authorizationKey,
      ],
    );

    if (existing.rows[0]) {
      return { ...existing.rows[0], existing: true };
    }

    const inserted = await client.query<{
      action: 'oracle.proofAuthorized';
      id: number;
      meta: OracleMutationAuditMeta;
    }>(
      `INSERT INTO audit_log (action, actor_id, target_id, meta)
       VALUES ('oracle.proofAuthorized', $1, $2, $3)
       RETURNING id, action, meta`,
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
 * exists without audit evidence. The proof-derived authorization key prevents
 * retries from applying the same authorization twice.
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

  const meta: OracleMutationAuditMeta = {
    action: input.action,
    authorizationKey: authorizationKey({ ...input, audit }),
    authorizedAt: new Date().toISOString(),
    collection: input.collection,
    oracleCommunityDid: audit.oracle.communityDid,
    oracleName: audit.oracle.name,
    operation: input.operation,
    proof: audit.proof,
    ...(input.record
      ? { recordCid: (await cidForRecord(input.record)).toString() }
      : {}),
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
