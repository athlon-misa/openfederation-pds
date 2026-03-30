/**
 * Keypair utilities for AT Protocol repo operations.
 *
 * Converts stored encrypted signing keys to @atproto/crypto Keypair objects
 * for use in Repo.create(), Repo.applyWrites(), etc.
 *
 * Uses a bounded TTL cache to avoid repeated PBKDF2 derivation (100K iterations)
 * on every write request. Cache entries expire after 5 minutes.
 */

import { Secp256k1Keypair } from '@atproto/crypto';
import { getSigningKey } from '../identity/manager.js';
import { getUserSigningKey } from '../identity/user-identity.js';
import { getCachedKeypair, setCachedKeypair } from '../auth/keypair-cache.js';

/**
 * Retrieve the signing keypair for a DID from cache or database.
 * Checks community signing_keys first, then falls back to user_signing_keys.
 * Decrypts the stored key and returns a Secp256k1Keypair suitable for repo signing.
 */
export async function getKeypairForDid(did: string): Promise<Secp256k1Keypair> {
  // Check cache first — avoids PBKDF2 + DB query on cache hit
  const cached = getCachedKeypair(did);
  if (cached) return cached;

  // Try community signing keys first
  let signingKeyBase64 = await getSigningKey(did);

  // Fall back to user signing keys
  if (!signingKeyBase64) {
    signingKeyBase64 = await getUserSigningKey(did);
  }

  if (!signingKeyBase64) {
    throw new Error(`No signing key found for DID: ${did}`);
  }
  const keyBytes = Buffer.from(signingKeyBase64, 'base64');
  const keypair = await Secp256k1Keypair.import(keyBytes, { exportable: false });

  // Cache the result to avoid repeated PBKDF2 on subsequent writes
  setCachedKeypair(did, keypair);

  return keypair;
}
