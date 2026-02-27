import crypto from 'crypto';
import { hashToken } from './tokens.js';

const PARTNER_KEY_PREFIX = 'ofp_';

/**
 * Generate a new partner API key.
 * Returns the raw key (shown once) and its SHA-256 hash (stored in DB).
 */
export function generatePartnerKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const randomBytes = crypto.randomBytes(48);
  const rawKey = PARTNER_KEY_PREFIX + randomBytes.toString('base64url');
  const keyHash = hashToken(rawKey);
  const keyPrefix = rawKey.substring(0, PARTNER_KEY_PREFIX.length + 8);
  return { rawKey, keyHash, keyPrefix };
}

/**
 * Validate that a string looks like a partner key format.
 */
export function isValidPartnerKeyFormat(key: string): boolean {
  return key.startsWith(PARTNER_KEY_PREFIX) && key.length > PARTNER_KEY_PREFIX.length + 8;
}

/**
 * Hash a partner key for DB lookup (same as token hashing).
 */
export function hashPartnerKey(key: string): string {
  return hashToken(key);
}
