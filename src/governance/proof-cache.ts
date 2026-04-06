/**
 * Proof Cache
 *
 * Stores and retrieves governance proof verification results
 * in PostgreSQL to avoid redundant on-chain lookups.
 */

import crypto from 'crypto';
import { query } from '../db/client.js';
import type { GovernanceProof, VerificationResult } from './chain-adapter.js';

interface CachedVerification {
  verified: boolean;
  error: string | null;
  blockTimestamp: number | null;
  confirmations: number | null;
  verifiedAt: string;
}

/**
 * Look up a previously cached verification result.
 * Returns null if no cached result exists.
 */
export async function getCachedVerification(
  chainId: string,
  txHash: string
): Promise<CachedVerification | null> {
  const result = await query<{
    verified: boolean;
    error: string | null;
    block_timestamp: string | null;
    confirmations: number | null;
    verified_at: string;
  }>(
    `SELECT verified, error, block_timestamp, confirmations, verified_at
     FROM proof_verifications
     WHERE chain_id = $1 AND transaction_hash = $2`,
    [chainId, txHash]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    verified: row.verified,
    error: row.error,
    blockTimestamp: row.block_timestamp ? parseInt(row.block_timestamp, 10) : null,
    confirmations: row.confirmations,
    verifiedAt: row.verified_at,
  };
}

/**
 * Store a verification result in the cache.
 * Uses UPSERT (ON CONFLICT) so re-verifying the same tx overwrites the old result.
 */
export async function cacheVerification(
  communityDid: string,
  proof: GovernanceProof,
  result: VerificationResult,
  oracleCredentialId?: string
): Promise<void> {
  const id = crypto.randomUUID();

  await query(
    `INSERT INTO proof_verifications
       (id, community_did, chain_id, transaction_hash, block_number, contract_address,
        verified, error, block_timestamp, confirmations, oracle_credential_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (chain_id, transaction_hash)
     DO UPDATE SET
       verified = EXCLUDED.verified,
       error = EXCLUDED.error,
       block_timestamp = EXCLUDED.block_timestamp,
       confirmations = EXCLUDED.confirmations,
       oracle_credential_id = EXCLUDED.oracle_credential_id,
       verified_at = CURRENT_TIMESTAMP`,
    [
      id,
      communityDid,
      proof.chainId,
      proof.transactionHash,
      proof.blockNumber ?? null,
      proof.contractAddress ?? null,
      result.verified,
      result.error ?? null,
      result.blockTimestamp ?? null,
      result.confirmations ?? null,
      oracleCredentialId ?? null,
    ]
  );
}
