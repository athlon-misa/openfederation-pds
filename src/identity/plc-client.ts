/**
 * PLC Directory Client
 *
 * Implements the did:plc protocol for registering and resolving DIDs
 * with a PLC directory server. Uses DAG-CBOR encoding and @atproto/crypto
 * for signing operations.
 *
 * Protocol reference: https://web.plc.directory/spec/v0.1/did-plc
 */

import crypto from 'crypto';
import type { Keypair } from '@atproto/crypto';
import { config } from '../config.js';

// @ipld/dag-cbor is available as a transitive dependency from @atproto/repo
// It uses CJS so we import with createRequire
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dagCbor = require('@ipld/dag-cbor') as { encode: (obj: unknown) => Uint8Array; decode: (bytes: Uint8Array) => unknown };

/**
 * Unsigned PLC operation (before signing).
 * Fields are ordered as required by the PLC protocol.
 */
interface PlcOperation {
  type: 'plc_operation';
  prev: string | null;
  rotationKeys: string[];
  verificationMethods: Record<string, string>;
  alsoKnownAs: string[];
  services: Record<string, { type: string; endpoint: string }>;
}

/**
 * Signed PLC operation (ready to submit to directory).
 */
interface SignedPlcOperation extends PlcOperation {
  sig: string; // base64url-encoded signature
}

/**
 * Register a did:plc with the PLC directory.
 *
 * Creates a genesis operation, signs it with the first rotation key,
 * derives the DID from the hash, and submits to the directory.
 *
 * @returns The registered DID string (e.g., "did:plc:abc123...")
 */
export async function registerDidPlc(opts: {
  signingKey: Keypair;
  rotationKeys: Keypair[];
  handle: string;
  pdsEndpoint: string;
}): Promise<string> {
  // Build unsigned genesis operation
  const unsignedOp: PlcOperation = {
    type: 'plc_operation',
    prev: null,
    rotationKeys: opts.rotationKeys.map(k => k.did()),
    verificationMethods: {
      atproto: opts.signingKey.did(),
    },
    alsoKnownAs: [`at://${opts.handle}`],
    services: {
      atproto_pds: {
        type: 'AtprotoPersonalDataServer',
        endpoint: opts.pdsEndpoint,
      },
    },
  };

  // Encode with DAG-CBOR and sign with the first rotation key
  const opBytes = dagCbor.encode(unsignedOp);
  const signature = await opts.rotationKeys[0].sign(opBytes);
  const sig = base64UrlEncode(signature);

  // Build signed operation
  const signedOp: SignedPlcOperation = {
    ...unsignedOp,
    sig,
  };

  // Derive DID from the signed genesis operation
  // did:plc uses SHA-256 of the DAG-CBOR-encoded signed operation, base32-lower, truncated to 24 chars
  const signedBytes = dagCbor.encode(signedOp);
  const hash = crypto.createHash('sha256').update(signedBytes).digest();
  const did = `did:plc:${base32Lower(hash).substring(0, 24)}`;

  // Submit to PLC directory
  const directoryUrl = config.plc.directoryUrl;
  const url = `${directoryUrl}/${did}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signedOp),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `PLC directory rejected DID registration (${response.status}): ${body}`
    );
  }

  return did;
}

/**
 * Resolve a DID document from the PLC directory.
 *
 * @returns The DID document, or null if not found
 */
export async function resolveFromPlc(did: string): Promise<Record<string, unknown> | null> {
  const directoryUrl = config.plc.directoryUrl;
  const url = `${directoryUrl}/${did}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `PLC directory lookup failed (${response.status}): ${await response.text()}`
    );
  }

  return await response.json() as Record<string, unknown>;
}

/**
 * Base32-lower encoding (RFC 4648, lowercase, no padding).
 * Matches the PLC directory's DID derivation format.
 */
function base32Lower(buffer: Buffer | Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let result = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 0x1f];
  }

  return result;
}

/**
 * Base64url encoding without padding (RFC 7515).
 */
function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
