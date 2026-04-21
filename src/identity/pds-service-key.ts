/**
 * PDS service-DID signing key management.
 *
 * The PDS publishes a did:web DID document at /.well-known/did.json when the
 * request hostname matches config.pds.hostname. That doc carries a Multikey
 * verificationMethod backed by a dedicated secp256k1 key — this module
 * generates, stores, and loads it.
 *
 * Separate from user / community / wallet signing keys so the PDS's
 * identity doesn't overlap with any user-facing key and can rotate
 * independently.
 */

import { Secp256k1Keypair } from '@atproto/crypto';
import { query } from '../db/client.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';
import { toMultibaseMultikeySecp256k1 } from './manager.js';

export interface PdsServiceKey {
  hostname: string;
  publicKeyMultibase: string;
}

/**
 * Ensure a service signing key exists for the given hostname. Generates one
 * atomically on first call (multiple concurrent callers are safe — we
 * INSERT ON CONFLICT DO NOTHING and re-read). Idempotent.
 */
export async function ensurePdsServiceKey(hostname: string): Promise<PdsServiceKey> {
  const existing = await query<{ public_key_multibase: string }>(
    `SELECT public_key_multibase FROM pds_service_keys WHERE hostname = $1`,
    [hostname]
  );
  if (existing.rows.length > 0) {
    return { hostname, publicKeyMultibase: existing.rows[0].public_key_multibase };
  }

  const keypair = await Secp256k1Keypair.create({ exportable: true });
  const privateKeyBytes = Buffer.from(await keypair.export());
  const publicKeyMultibase = toMultibaseMultikeySecp256k1(keypair.publicKeyBytes());
  const encrypted = await encryptKeyBytes(privateKeyBytes);

  // Insert; if another boot racer beat us to it, silently keep their row and
  // return the DB's version to stay consistent.
  await query(
    `INSERT INTO pds_service_keys (hostname, public_key_multibase, private_key_encrypted)
     VALUES ($1, $2, $3)
     ON CONFLICT (hostname) DO NOTHING`,
    [hostname, publicKeyMultibase, encrypted]
  );

  const row = await query<{ public_key_multibase: string }>(
    `SELECT public_key_multibase FROM pds_service_keys WHERE hostname = $1`,
    [hostname]
  );
  if (row.rows.length === 0) {
    throw new Error(`ensurePdsServiceKey: row missing after insert for ${hostname}`);
  }
  return { hostname, publicKeyMultibase: row.rows[0].public_key_multibase };
}

/** Load the decrypted keypair for the given hostname, or null if absent. */
export async function loadPdsServiceKeypair(hostname: string): Promise<Secp256k1Keypair | null> {
  const row = await query<{ private_key_encrypted: Buffer }>(
    `SELECT private_key_encrypted FROM pds_service_keys WHERE hostname = $1`,
    [hostname]
  );
  if (row.rows.length === 0) return null;
  const privateKey = await decryptKeyBytes(row.rows[0].private_key_encrypted);
  return Secp256k1Keypair.import(privateKey, { exportable: false });
}
