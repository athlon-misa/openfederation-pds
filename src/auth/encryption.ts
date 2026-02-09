import crypto from 'crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

function deriveKey(secret: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(secret, salt, ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * Encrypt data using AES-256-GCM with a derived key from KEY_ENCRYPTION_SECRET.
 * Returns a buffer: [salt (32)] [iv (16)] [authTag (16)] [ciphertext (...)]
 */
export function encryptKeyBytes(plaintext: Buffer): Buffer {
  const secret = config.keyEncryptionSecret;
  if (!secret) {
    throw new Error('KEY_ENCRYPTION_SECRET must be set to encrypt keys at rest');
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(secret, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypt data that was encrypted with encryptKeyBytes.
 */
export function decryptKeyBytes(cipherBundle: Buffer): Buffer {
  const secret = config.keyEncryptionSecret;
  if (!secret) {
    throw new Error('KEY_ENCRYPTION_SECRET must be set to decrypt keys at rest');
  }

  const salt = cipherBundle.subarray(0, SALT_LENGTH);
  const iv = cipherBundle.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = cipherBundle.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = cipherBundle.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
