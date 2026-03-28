import crypto from 'crypto';
import { hashToken } from './tokens.js';

const ORACLE_KEY_PREFIX = 'ofo_';

/**
 * Generate a new Oracle API key.
 * Returns the raw key (shown once) and its SHA-256 hash (stored in DB).
 */
export function generateOracleKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const randomBytes = crypto.randomBytes(48);
  const rawKey = ORACLE_KEY_PREFIX + randomBytes.toString('base64url');
  const keyHash = hashToken(rawKey);
  const keyPrefix = rawKey.substring(0, ORACLE_KEY_PREFIX.length + 12);
  return { rawKey, keyHash, keyPrefix };
}

/**
 * Validate that a string looks like an Oracle key format.
 */
export function isValidOracleKeyFormat(key: string): boolean {
  return key.startsWith(ORACLE_KEY_PREFIX) && key.length > ORACLE_KEY_PREFIX.length + 8;
}

/**
 * Hash an Oracle key for DB lookup.
 */
export function hashOracleKey(key: string): string {
  return hashToken(key);
}
