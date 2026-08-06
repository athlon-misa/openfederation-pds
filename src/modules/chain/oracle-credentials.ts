/**
 * Chain module: Oracle credential lookup.
 *
 * Moved out of `src/auth/verification.ts` — an Oracle credential is chain
 * module surface, not core auth. Core's auth verification knows nothing about
 * it; the module reaches down into core's `query()` like any other module.
 */

import { query } from '../../db/client.js';
import { isValidOracleKeyFormat, hashOracleKey } from './oracle-keys.js';
import type { OracleContext } from './oracle-context.js';

export type OracleVerificationResult =
  | { ok: true; oracle: OracleContext }
  | { ok: false };

export async function verifyOracleKey(opts: {
  rawKey?: string;
  origin?: string;
}): Promise<OracleVerificationResult> {
  if (!opts.rawKey || !isValidOracleKeyFormat(opts.rawKey)) return { ok: false };

  const keyHash = hashOracleKey(opts.rawKey);
  const result = await query<{
    id: string;
    community_did: string;
    name: string;
    status: string;
    allowed_origins: string[] | null;
  }>(
    `SELECT id, community_did, name, status, allowed_origins
     FROM oracle_credentials WHERE key_hash = $1`,
    [keyHash],
  );

  if (result.rows.length === 0) return { ok: false };

  const credential = result.rows[0];
  if (credential.status !== 'active') return { ok: false };

  if (credential.allowed_origins && credential.allowed_origins.length > 0) {
    if (!opts.origin || !credential.allowed_origins.includes(opts.origin)) return { ok: false };
  }

  query(
    'UPDATE oracle_credentials SET last_used_at = CURRENT_TIMESTAMP, proofs_submitted = proofs_submitted + 1 WHERE id = $1',
    [credential.id],
  ).catch(() => {});

  return {
    ok: true,
    oracle: {
      credentialId: credential.id,
      communityDid: credential.community_did,
      name: credential.name,
    },
  };
}
