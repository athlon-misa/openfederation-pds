import crypto from 'crypto';
import { promisify } from 'util';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;
const ENVELOPE_MAGIC = Buffer.from('OFKW1');

export type KeyWrapPurpose =
  | 'activitypub.signing-key'
  | 'attestation.dek'
  | 'identity.pds-service-key'
  | 'identity.recovery-key'
  | 'identity.signing-key'
  | 'vault.share'
  | 'wallet.custodial-key';

const pbkdf2 = promisify(crypto.pbkdf2);

async function deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
  return pbkdf2(secret, salt, ITERATIONS, KEY_LENGTH, 'sha512');
}

function getKeyEncryptionSecret(action: 'encrypt' | 'decrypt'): string {
  const secret = config.keyEncryptionSecret;
  if (!secret) {
    throw new Error(`KEY_ENCRYPTION_SECRET must be set to ${action} keys at rest`);
  }
  return secret;
}

function aadForPurpose(purpose: KeyWrapPurpose): Buffer {
  return Buffer.from(`openfederation:key-wrap:v1:${purpose}`, 'utf-8');
}

export async function wrapKeyBytes(plaintext: Buffer, purpose: KeyWrapPurpose): Promise<Buffer> {
  const secret = getKeyEncryptionSecret('encrypt');
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await deriveKey(secret, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aadForPurpose(purpose));

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([ENVELOPE_MAGIC, salt, iv, authTag, encrypted]);
}

export async function unwrapKeyBytes(cipherBundle: Buffer, purpose: KeyWrapPurpose): Promise<Buffer> {
  const secret = getKeyEncryptionSecret('decrypt');

  if (cipherBundle.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
    return unwrapPurposeBound(cipherBundle.subarray(ENVELOPE_MAGIC.length), secret, purpose);
  }

  return unwrapLegacy(cipherBundle, secret);
}

async function unwrapPurposeBound(
  body: Buffer,
  secret: string,
  purpose: KeyWrapPurpose,
): Promise<Buffer> {
  const minimumLength = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (body.length < minimumLength) {
    throw new Error('Encrypted key bundle is truncated');
  }

  const salt = body.subarray(0, SALT_LENGTH);
  const iv = body.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = body.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = body.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = await deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(aadForPurpose(purpose));
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function unwrapLegacy(cipherBundle: Buffer, secret: string): Promise<Buffer> {
  const minimumLength = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (cipherBundle.length < minimumLength) {
    throw new Error('Encrypted key bundle is truncated');
  }

  const salt = cipherBundle.subarray(0, SALT_LENGTH);
  const iv = cipherBundle.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = cipherBundle.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = cipherBundle.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = await deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
