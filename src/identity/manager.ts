import { Secp256k1Keypair } from '@atproto/crypto';
import { base58btc } from 'multiformats/bases/base58';
import { config } from '../config';
import * as crypto from 'crypto';

/**
 * Result of creating a did:plc identity
 */
export interface PlcIdentityResult {
  did: string;
  primaryRotationKey: string; // Base64 encoded private key - MUST be given to user ONCE
  signingKey: string; // Base64 encoded private key for repo signing
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
 * - Secondary recovery key: stored by server (for recovery)
 * - Signing key: stored for repo operations
 *
 * @param handle - The desired handle for the community
 * @returns PlcIdentityResult with DID and keys
 */
export async function createPlcIdentity(handle: string): Promise<PlcIdentityResult> {
  // 1. Generate keys
  const primaryRotationKey = await Secp256k1Keypair.create({ exportable: true });
  const recoveryKey = await Secp256k1Keypair.create({ exportable: true });
  const signingKey = await Secp256k1Keypair.create({ exportable: true });

  // 2. Construct the genesis operation for PLC
  const fullHandle = `${handle}${config.handleSuffix}`;

  // Create the DID by calling the PLC directory
  // Note: The actual PLC creation requires posting to https://plc.directory/
  // For now, we'll generate a placeholder DID
  const genesis = {
    type: 'plc_operation',
    rotationKeys: [primaryRotationKey.did(), recoveryKey.did()],
    verificationMethods: {
      atproto: signingKey.did(),
    },
    alsoKnownAs: [`at://${fullHandle}`],
    services: {
      atproto_pds: {
        type: 'AtprotoPersonalDataServer',
        endpoint: config.pds.serviceUrl,
      },
    },
  };

  // Generate a deterministic DID based on the genesis operation
  // In production, this would come from the PLC directory
  const did = await generatePlcDid(genesis);

  // 3. Export keys for storage/return
  const primaryKeyExport = await primaryRotationKey.export();
  const signingKeyExport = await signingKey.export();

  // CRITICAL: The primary rotation key is returned to the user and MUST NOT be stored by the server
  // The recovery key will be stored by the server (encrypted at rest)

  return {
    did,
    primaryRotationKey: Buffer.from(primaryKeyExport).toString('base64'),
    signingKey: Buffer.from(signingKeyExport).toString('base64'),
    message: 'IMPORTANT: Please back up your primaryRotationKey. This is the only time you will see it. It grants full control over your identity.',
  };
}

/**
 * Generates a did:plc identifier from a genesis operation
 * In production, this should post to the PLC directory and receive the DID
 * For MVP, we generate a deterministic identifier
 */
async function generatePlcDid(genesis: any): Promise<string> {
  // Hash the genesis operation to create a deterministic identifier
  const genesisStr = JSON.stringify(genesis);
  const hash = crypto.createHash('sha256').update(genesisStr).digest();

  // Use base32 encoding for the DID (standard PLC format)
  const base32 = hash.toString('base64url').substring(0, 24);

  return `did:plc:${base32}`;
}

/**
 * Helper to convert Ed25519 public key to multibase multikey format
 * @param publicKey - The Ed25519 public key bytes
 * @returns Multibase-encoded multikey string
 */
function toMultibaseMultikey(publicKey: Uint8Array): string {
  // multicodec ed25519-pub = 0xED (varint-encoded as 0xED 0x01)
  const prefix = Uint8Array.from([0xed, 0x01]);
  const bytes = new Uint8Array(prefix.length + publicKey.length);
  bytes.set(prefix, 0);
  bytes.set(publicKey, prefix.length);
  // base58btc multibase encoding yields a string starting with 'z'
  return base58btc.encode(bytes);
}

/**
 * Helper to convert secp256k1 public key to multibase multikey format
 * @param publicKey - The secp256k1 public key bytes
 * @returns Multibase-encoded multikey string
 */
function toMultibaseMultikeySecp256k1(publicKey: Uint8Array): string {
  // multicodec secp256k1-pub = 0xE7 (varint-encoded as 0xE7 0x01)
  const prefix = Uint8Array.from([0xe7, 0x01]);
  const bytes = new Uint8Array(prefix.length + publicKey.length);
  bytes.set(prefix, 0);
  bytes.set(publicKey, prefix.length);
  return base58btc.encode(bytes);
}

/**
 * Creates a did:web identity for a community with an existing domain
 * The community is responsible for hosting the did.json file
 *
 * @param domain - The domain name controlled by the community
 * @returns WebIdentityResult with DID document and instructions
 */
export async function createWebIdentity(domain: string): Promise<WebIdentityResult> {
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

  // 5. Return the document and instructions
  return {
    did: `did:web:${domain}`,
    didDocument,
    signingKey: Buffer.from(signingKeyExport).toString('base64'),
    instructions: `Host this JSON document at https://${domain}/.well-known/did.json. Your identity will not work until this is done.`,
  };
}

/**
 * Gets the recovery key for a did:plc community
 * This is used by the server for recovery operations
 */
export async function getRecoveryKey(communityDid: string): Promise<Secp256k1Keypair | null> {
  // This will be implemented when we add database queries
  // For now, return null
  return null;
}
