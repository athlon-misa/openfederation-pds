import crypto from 'crypto';

/**
 * Generate a 32-byte AES-256 session key and its SHA-256 hash.
 * The hash is stored in the database; the raw key is returned to the client once.
 */
export function generateSessionKey(): { key: Buffer; keyHash: string } {
  const key = crypto.randomBytes(32);
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  return { key, keyHash };
}

/**
 * Encrypt data using AES-256-GCM with a session key.
 * Returns the ciphertext, IV, and authentication tag as base64 strings.
 */
export function encryptWithSessionKey(data: string, sessionKey: Buffer): { ciphertext: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(12); // 12 bytes for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf-8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypt data using AES-256-GCM with a session key.
 */
export function decryptWithSessionKey(ciphertext: string, sessionKey: Buffer, iv: string, authTag: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf-8');
}
