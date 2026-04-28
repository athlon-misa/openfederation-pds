import type { Request } from 'express';
import { verifyOracleKey } from './verification.js';

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
  const result = await verifyOracleKey({
    rawKey: req.headers['x-oracle-key'] as string | undefined,
    origin: req.headers.origin as string | undefined,
  });
  return result.ok ? result.oracle : null;
}
