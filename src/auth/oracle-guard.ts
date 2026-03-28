import type { Request } from 'express';
import { query } from '../db/client.js';
import { isValidOracleKeyFormat, hashOracleKey } from './oracle-keys.js';

export interface OracleContext {
  credentialId: string;
  communityDid: string;
  name: string;
}

/**
 * Validate an X-Oracle-Key header and return the Oracle context.
 * Returns null if the key is missing, invalid, or doesn't match.
 * Does NOT send error responses — caller decides how to handle null.
 */
export async function validateOracleKey(req: Request): Promise<OracleContext | null> {
  const rawKey = req.headers['x-oracle-key'] as string | undefined;
  if (!rawKey || !isValidOracleKeyFormat(rawKey)) return null;

  const keyHash = hashOracleKey(rawKey);

  const result = await query<{
    id: string;
    community_did: string;
    name: string;
    status: string;
    allowed_origins: string[] | null;
  }>(
    `SELECT id, community_did, name, status, allowed_origins
     FROM oracle_credentials WHERE key_hash = $1`,
    [keyHash]
  );

  if (result.rows.length === 0) return null;

  const cred = result.rows[0];
  if (cred.status !== 'active') return null;

  // Validate origin if allowed_origins is set
  if (cred.allowed_origins && cred.allowed_origins.length > 0) {
    const origin = req.headers.origin as string | undefined;
    if (!origin || !cred.allowed_origins.includes(origin)) return null;
  }

  // Update usage stats (fire-and-forget)
  query(
    'UPDATE oracle_credentials SET last_used_at = CURRENT_TIMESTAMP, proofs_submitted = proofs_submitted + 1 WHERE id = $1',
    [cred.id]
  ).catch(() => {});

  return {
    credentialId: cred.id,
    communityDid: cred.community_did,
    name: cred.name,
  };
}
