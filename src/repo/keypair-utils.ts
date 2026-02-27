/**
 * Keypair utilities for AT Protocol repo operations.
 *
 * Converts stored encrypted signing keys to @atproto/crypto Keypair objects
 * for use in Repo.create(), Repo.applyWrites(), etc.
 *
 * Checks both community signing_keys and user_signing_keys tables.
 */

import { Secp256k1Keypair } from '@atproto/crypto';
import { getSigningKey } from '../identity/manager.js';
import { getUserSigningKey } from '../identity/user-identity.js';

/**
 * Retrieve the signing keypair for a DID from the database.
 * Checks community signing_keys first, then falls back to user_signing_keys.
 * Decrypts the stored key and returns a Secp256k1Keypair suitable for repo signing.
 */
export async function getKeypairForDid(did: string): Promise<Secp256k1Keypair> {
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
  return Secp256k1Keypair.import(keyBytes, { exportable: false });
}
