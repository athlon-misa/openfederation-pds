// src/identity/external-keys.ts

import { base58btc } from 'multiformats/bases/base58';
import nacl from 'tweetnacl';
import { secp256k1 } from '@noble/curves/secp256k1';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';

/**
 * Supported external key types and their multicodec prefixes.
 * These are the first bytes after multibase decoding.
 */
export const KEY_TYPE_MULTICODEC: Record<string, number[]> = {
  ed25519:   [0xed, 0x01],
  x25519:    [0xec, 0x01],
  secp256k1: [0xe7, 0x01],
  p256:      [0x80, 0x24],
};

export const VALID_KEY_TYPES = Object.keys(KEY_TYPE_MULTICODEC);

/** Expected raw public key lengths (bytes, after multicodec prefix) */
const KEY_LENGTHS: Record<string, number> = {
  ed25519: 32,
  x25519: 32,
  secp256k1: 33, // compressed
  p256: 33,      // compressed
};

export interface ExternalKeyRecord {
  type: string;
  purpose: string;
  publicKey: string;
  label?: string;
  createdAt: string;
}

export type ValidateKeyResult =
  | { valid: true }
  | { valid: false; error: string };

export const EXTERNAL_KEY_PROOF_DOMAIN = 'OpenFederation External Key Claim v1';

/**
 * Return the canonical, context-bound payload a claimant must sign. Binding
 * every mutable field prevents a signature for one DID, record, or purpose
 * being replayed to create a different claim.
 */
export function externalKeyProofMessage(
  did: string,
  rkey: string,
  type: string,
  purpose: string,
  publicKey: string,
): Uint8Array {
  return new TextEncoder().encode(
    [EXTERNAL_KEY_PROOF_DOMAIN, did, rkey, type, purpose, publicKey].join('\n'),
  );
}

/** Verify a base64url detached signature from the public key being claimed. */
export function verifyExternalKeyProof(
  did: string,
  rkey: string,
  type: string,
  purpose: string,
  publicKey: string,
  proof: string,
): ValidateKeyResult {
  if (type === 'x25519') {
    return { valid: false, error: 'x25519 keys cannot produce signature proofs' };
  }

  try {
    const signature = new Uint8Array(Buffer.from(proof, 'base64url'));
    if (signature.length !== 64 || Buffer.from(signature).toString('base64url') !== proof) {
      return { valid: false, error: 'Proof must be a canonical base64url 64-byte signature' };
    }

    const encodedKey = base58btc.decode(publicKey);
    const rawPublicKey = encodedKey.slice(KEY_TYPE_MULTICODEC[type].length);
    const message = externalKeyProofMessage(did, rkey, type, purpose, publicKey);
    const valid = type === 'ed25519'
      ? nacl.sign.detached.verify(message, signature, rawPublicKey)
      : type === 'secp256k1'
        ? secp256k1.verify(signature, sha256(message), rawPublicKey, { prehash: false, format: 'compact' })
        : type === 'p256'
          ? p256.verify(signature, sha256(message), rawPublicKey, { prehash: false, format: 'compact' })
          : false;

    return valid ? { valid: true } : { valid: false, error: 'Proof signature does not match public key' };
  } catch {
    return { valid: false, error: 'Proof is not a valid signature for this public key' };
  }
}

/**
 * Validate that a multibase-encoded public key matches the declared type.
 * Expects base58btc encoding (z prefix) with the correct multicodec prefix.
 */
export function validatePublicKey(publicKey: string, type: string): ValidateKeyResult {
  if (!VALID_KEY_TYPES.includes(type)) {
    return { valid: false, error: `Unsupported key type: ${type}. Must be one of: ${VALID_KEY_TYPES.join(', ')}` };
  }

  if (!publicKey.startsWith('z')) {
    return { valid: false, error: 'Public key must be multibase base58btc encoded (z prefix)' };
  }

  let decoded: Uint8Array;
  try {
    decoded = base58btc.decode(publicKey);
  } catch {
    return { valid: false, error: 'Invalid base58btc encoding' };
  }

  const expectedPrefix = KEY_TYPE_MULTICODEC[type];
  if (decoded.length < expectedPrefix.length) {
    return { valid: false, error: 'Public key too short' };
  }

  for (let i = 0; i < expectedPrefix.length; i++) {
    if (decoded[i] !== expectedPrefix[i]) {
      return { valid: false, error: `Multicodec prefix does not match type "${type}"` };
    }
  }

  const rawKeyLength = decoded.length - expectedPrefix.length;
  const expectedLength = KEY_LENGTHS[type];
  if (rawKeyLength !== expectedLength) {
    return { valid: false, error: `Invalid key length for ${type}: expected ${expectedLength} bytes, got ${rawKeyLength}` };
  }

  return { valid: true };
}

/**
 * Validate an rkey for external key records.
 * Must be 1-512 chars, alphanumeric + hyphens, no leading/trailing hyphens.
 */
export function validateRkey(rkey: string): ValidateKeyResult {
  if (!rkey || rkey.length === 0 || rkey.length > 512) {
    return { valid: false, error: 'rkey must be 1-512 characters' };
  }
  if (rkey.length === 1 && !/^[a-zA-Z0-9]$/.test(rkey)) {
    return { valid: false, error: 'rkey must be alphanumeric' };
  }
  if (rkey.length > 1 && !/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(rkey)) {
    return { valid: false, error: 'rkey must be alphanumeric with hyphens, no leading/trailing hyphens' };
  }
  return { valid: true };
}

/**
 * Validate the purpose field.
 */
export function validatePurpose(purpose: string): ValidateKeyResult {
  if (!purpose || purpose.length === 0 || purpose.length > 64) {
    return { valid: false, error: 'purpose must be 1-64 characters' };
  }
  return { valid: true };
}

/**
 * Validate the label field (optional).
 */
export function validateLabel(label: string | undefined): ValidateKeyResult {
  if (label !== undefined && label.length > 100) {
    return { valid: false, error: 'label must be at most 100 characters' };
  }
  return { valid: true };
}

/** The collection name for external key records */
export const EXTERNAL_KEY_COLLECTION = 'net.openfederation.identity.externalKey';
