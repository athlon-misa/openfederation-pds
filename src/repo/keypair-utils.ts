/**
 * Keypair utilities for AT Protocol repo operations.
 *
 * Converts stored encrypted signing keys to @atproto/crypto Keypair objects
 * for use in Repo.create(), Repo.applyWrites(), etc.
 */

import { Secp256k1Keypair } from '@atproto/crypto';
import { getSigningKey } from '../identity/manager.js';

/**
 * Retrieve the signing keypair for a DID from the database.
 * Decrypts the stored key and returns a Secp256k1Keypair suitable for repo signing.
 */
export async function getKeypairForDid(did: string): Promise<Secp256k1Keypair> {
  const signingKeyBase64 = await getSigningKey(did);
  if (!signingKeyBase64) {
    throw new Error(`No signing key found for DID: ${did}`);
  }
  const keyBytes = Buffer.from(signingKeyBase64, 'base64');
  return Secp256k1Keypair.import(keyBytes, { exportable: false });
}
