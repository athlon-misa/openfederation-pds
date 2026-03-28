/**
 * User Identity Creation
 *
 * Creates real did:plc identities for users with signing keys and personal repos.
 * Unlike communities (where the primary rotation key is given to the owner),
 * user rotation keys are PDS-managed for simplicity in v1.
 * Users can later request their rotation key for migration.
 */

import { Secp256k1Keypair } from '@atproto/crypto';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';
import { registerDidPlc } from './plc-client.js';

export interface UserIdentityResult {
  did: string;
  signingKeyBase64: string; // For encrypted storage in user_signing_keys
}

/**
 * Create a real did:plc identity for a user.
 *
 * Generates signing + rotation keys, registers the DID with the PLC directory,
 * and returns the DID and signing key for storage.
 *
 * The PDS holds both rotation and signing keys for users (unlike communities
 * where the primary rotation key is given to the owner).
 */
export async function createUserIdentity(handle: string): Promise<UserIdentityResult> {
  // Generate keys
  const signingKey = await Secp256k1Keypair.create({ exportable: true });
  const rotationKey = await Secp256k1Keypair.create({ exportable: true });

  // Build full handle with suffix
  const fullHandle = `${handle}${config.handleSuffix}`;

  // Register with PLC directory
  const did = await registerDidPlc({
    signingKey,
    rotationKeys: [rotationKey],
    handle: fullHandle,
    pdsEndpoint: config.pds.serviceUrl,
  });

  // Export signing key for encrypted storage
  const signingKeyExport = await signingKey.export();
  const signingKeyBase64 = Buffer.from(signingKeyExport).toString('base64');

  return { did, signingKeyBase64 };
}

/**
 * Store a user's signing key encrypted at rest.
 */
export async function storeUserSigningKey(userDid: string, signingKeyBase64: string): Promise<void> {
  const keyBuf = Buffer.from(signingKeyBase64, 'base64');
  const encrypted = await encryptKeyBytes(keyBuf);
  await query(
    `INSERT INTO user_signing_keys (user_did, signing_key_bytes)
     VALUES ($1, $2)
     ON CONFLICT (user_did) DO UPDATE SET signing_key_bytes = $2`,
    [userDid, encrypted]
  );
}

/**
 * Retrieve and decrypt a user's signing key.
 */
export async function getUserSigningKey(userDid: string): Promise<string | null> {
  const result = await query<{ signing_key_bytes: Buffer }>(
    'SELECT signing_key_bytes FROM user_signing_keys WHERE user_did = $1',
    [userDid]
  );
  if (result.rows.length === 0) return null;
  const decrypted = await decryptKeyBytes(result.rows[0].signing_key_bytes);
  return decrypted.toString('base64');
}
