import {
  wrapKeyBytes,
  unwrapKeyBytes,
  type KeyWrapPurpose,
} from '../crypto/key-wrap.js';

/**
 * Compatibility export for older callers. New code should import
 * wrapKeyBytes/unwrapKeyBytes from src/crypto/key-wrap.ts directly.
 */
export async function encryptKeyBytes(plaintext: Buffer, purpose: KeyWrapPurpose): Promise<Buffer> {
  return wrapKeyBytes(plaintext, purpose);
}

/**
 * Decrypt data encrypted with encryptKeyBytes. Legacy ciphertexts without a
 * purpose-bound envelope still decrypt for existing database rows.
 */
export async function decryptKeyBytes(cipherBundle: Buffer, purpose: KeyWrapPurpose): Promise<Buffer> {
  return unwrapKeyBytes(cipherBundle, purpose);
}

export type { KeyWrapPurpose };
