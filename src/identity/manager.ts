import { Secp256k1Keypair } from '@atproto/crypto';
import { base58btc } from 'multiformats/bases/base58';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';
import { isValidDomain } from '../auth/utils.js';
import { registerDidPlc } from './plc-client.js';

/**
 * Result of creating a did:plc identity
 */
export interface PlcIdentityResult {
  did: string;
  primaryRotationKey: string; // Base64 encoded private key - MUST be given to user ONCE
  signingKey: string; // Base64 encoded private key for repo signing
  recoveryKeyBytes: Buffer; // Encrypted recovery key bytes for DB storage
  message: string;
}

/**
 * Result of creating a did:web identity
 */
export interface WebIdentityResult {
  did: string;
  didDocument: any;
  signingKey: string; // Base64 encoded private key for repo signing
  instructions: string;
}

/**
 * Creates a did:plc identity with hybrid key model:
 * - Primary rotation key: given to community (NOT stored by server)
 * - Secondary recovery key: stored by server (encrypted at rest)
 * - Signing key: stored for repo operations
 *
 * Registers the DID with the configured PLC directory.
 */
export async function createPlcIdentity(handle: string): Promise<PlcIdentityResult> {
  // 1. Generate keys
  const primaryRotationKey = await Secp256k1Keypair.create({ exportable: true });
  const recoveryKey = await Secp256k1Keypair.create({ exportable: true });
  const signingKey = await Secp256k1Keypair.create({ exportable: true });

  // 2. Register with PLC directory
  const fullHandle = `${handle}${config.handleSuffix}`;

  const did = await registerDidPlc({
    signingKey,
    rotationKeys: [primaryRotationKey, recoveryKey],
    handle: fullHandle,
    pdsEndpoint: config.pds.serviceUrl,
  });

  // 3. Export keys
  const primaryKeyExport = await primaryRotationKey.export();
  const recoveryKeyExport = await recoveryKey.export();
  const signingKeyExport = await signingKey.export();

  // 4. Encrypt recovery key for storage at rest
  const recoveryKeyBuf = Buffer.from(recoveryKeyExport);
  const encryptedRecoveryKey = encryptKeyBytes(recoveryKeyBuf);

  return {
    did,
    primaryRotationKey: Buffer.from(primaryKeyExport).toString('base64'),
    signingKey: Buffer.from(signingKeyExport).toString('base64'),
    recoveryKeyBytes: encryptedRecoveryKey,
    message: 'IMPORTANT: Please back up your primaryRotationKey. This is the only time you will see it. It grants full control over your identity.',
  };
}

/**
 * Validate a domain for did:web before constructing identity.
 * Throws if invalid.
 */
export function validateWebDomain(domain: string): void {
  if (!isValidDomain(domain)) {
    throw new Error(
      'Invalid domain. Must be a valid hostname (e.g., example.com). ' +
      'No paths, ports, or special characters allowed.'
    );
  }
}

/**
 * Helper to convert secp256k1 public key to multibase multikey format.
 * Used by did:web DID document construction and /.well-known/did.json endpoint.
 */
export function toMultibaseMultikeySecp256k1(publicKey: Uint8Array): string {
  // multicodec secp256k1-pub = 0xE7 (varint-encoded as 0xE7 0x01)
  const prefix = Uint8Array.from([0xe7, 0x01]);
  const bytes = new Uint8Array(prefix.length + publicKey.length);
  bytes.set(prefix, 0);
  bytes.set(publicKey, prefix.length);
  return base58btc.encode(bytes);
}

/**
 * Creates a did:web identity for a community with an existing domain.
 * Domain is validated before use.
 */
export async function createWebIdentity(domain: string): Promise<WebIdentityResult> {
  validateWebDomain(domain);

  // 1. Generate a signing key for the repository
  const signingKey = await Secp256k1Keypair.create({ exportable: true });

  // 2. Get the public key bytes
  const publicKeyBytes = signingKey.publicKeyBytes();

  // 3. Construct the did.json document
  const didDocument = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: `did:web:${domain}`,
    alsoKnownAs: [`at://${domain}`],
    verificationMethod: [
      {
        id: `did:web:${domain}#atproto`,
        type: 'Multikey',
        controller: `did:web:${domain}`,
        publicKeyMultibase: toMultibaseMultikeySecp256k1(publicKeyBytes),
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: config.pds.serviceUrl,
      },
    ],
  };

  // 4. Export the signing key for storage
  const signingKeyExport = await signingKey.export();

  return {
    did: `did:web:${domain}`,
    didDocument,
    signingKey: Buffer.from(signingKeyExport).toString('base64'),
    instructions: `Host this JSON document at https://${domain}/.well-known/did.json. Your identity will not work until this is done.`,
  };
}

/**
 * Store signing key for a community, encrypted at rest.
 */
export async function storeSigningKey(communityDid: string, signingKeyBase64: string): Promise<void> {
  const keyBuf = Buffer.from(signingKeyBase64, 'base64');
  const encrypted = encryptKeyBytes(keyBuf);
  await query(
    `INSERT INTO signing_keys (community_did, signing_key_bytes)
     VALUES ($1, $2)
     ON CONFLICT (community_did) DO UPDATE SET signing_key_bytes = $2`,
    [communityDid, encrypted]
  );
}

/**
 * Retrieve and decrypt signing key for a community.
 */
export async function getSigningKey(communityDid: string): Promise<string | null> {
  const result = await query<{ signing_key_bytes: Buffer }>(
    'SELECT signing_key_bytes FROM signing_keys WHERE community_did = $1',
    [communityDid]
  );
  if (result.rows.length === 0) return null;
  const decrypted = decryptKeyBytes(result.rows[0].signing_key_bytes);
  return decrypted.toString('base64');
}

/**
 * Gets the recovery key for a did:plc community.
 */
export async function getRecoveryKey(communityDid: string): Promise<Secp256k1Keypair | null> {
  const result = await query<{ recovery_key_bytes: Buffer }>(
    'SELECT recovery_key_bytes FROM plc_keys WHERE community_did = $1',
    [communityDid]
  );
  if (result.rows.length === 0) return null;

  const decrypted = decryptKeyBytes(result.rows[0].recovery_key_bytes);
  return Secp256k1Keypair.import(decrypted, { exportable: true });
}

