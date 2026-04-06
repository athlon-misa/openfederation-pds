import crypto from 'crypto';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';

/**
 * Generate a 32-byte Data Encryption Key (DEK) for AES-256-GCM attestation encryption.
 */
export function generateDEK(): Buffer {
  return crypto.randomBytes(32);
}

/**
 * Encrypt a claim object using AES-256-GCM with the provided DEK.
 * Returns ciphertext, IV, and authentication tag as base64 strings.
 */
export function encryptClaim(
  claim: Record<string, unknown>,
  dek: Buffer,
): { ciphertext: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const plaintext = JSON.stringify(claim);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypt a claim object using AES-256-GCM with the provided DEK.
 */
export function decryptClaim(
  ciphertext: string,
  dek: Buffer,
  iv: string,
  authTag: string,
): Record<string, unknown> {
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf-8'));
}

/**
 * Create a deterministic commitment hash of a claim object.
 * Keys are sorted for canonical JSON representation.
 */
export function createCommitment(claim: Record<string, unknown>): { hash: string } {
  const canonical = JSON.stringify(claim, Object.keys(claim).sort());
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  return { hash };
}

/**
 * Wrap (encrypt) a DEK using the server's KEY_ENCRYPTION_SECRET via encryptKeyBytes.
 * Returns the wrapped DEK as a base64 string.
 */
export async function wrapDEK(dek: Buffer): Promise<string> {
  const wrapped = await encryptKeyBytes(dek);
  return wrapped.toString('base64');
}

/**
 * Unwrap (decrypt) a wrapped DEK using the server's KEY_ENCRYPTION_SECRET.
 */
export async function unwrapDEK(wrappedBase64: string): Promise<Buffer> {
  return decryptKeyBytes(Buffer.from(wrappedBase64, 'base64'));
}
