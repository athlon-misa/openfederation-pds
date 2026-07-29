import type { OracleContext } from '../auth/oracle-guard.js';
import { auditLogRequired } from '../db/audit.js';
import { HttpError } from '../xrpc/errors.js';
import type { GovernanceProof } from './chain-adapter.js';
import type { GovernanceResult } from './enforcement.js';

export interface OracleMutationAudit {
  oracle: OracleContext;
  proof: GovernanceProof;
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

/**
 * Persist the proof against the authoritative credential/community context.
 * auditLogRequired propagates failures so callers cannot return success when
 * this security-critical audit event was not stored.
 */
export async function auditOracleMutation(input: {
  audit: OracleMutationAudit;
  communityDid: string;
  collection: string;
  rkey: string;
  action: 'write' | 'delete';
}): Promise<void> {
  await auditLogRequired(
    'oracle.proofApplied',
    input.audit.oracle.credentialId,
    input.communityDid,
    {
      collection: input.collection,
      rkey: input.rkey,
      action: input.action,
      proof: input.audit.proof,
      oracleCommunityDid: input.audit.oracle.communityDid,
      oracleName: input.audit.oracle.name,
    },
  );
}
