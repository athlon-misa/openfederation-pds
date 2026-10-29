/**
 * Encrypt to a did:key (secp256k1) so only the holder of that key can read
 * the bytes: ephemeral ECDH, HKDF-SHA256, AES-256-GCM. Used to hand a moved
 * community's attestation keys to its new PDS (#267), whose repo signing key
 * is named in the public DID document.
 */
import crypto from 'crypto';
import { parseDidKey } from '@atproto/crypto';

const INFO = 'openfederation.community.moved-keys.v1';

export function encryptToDidKey(recipientDidKey: string, plaintext: Buffer): Buffer {
  const { jwtAlg, keyBytes } = parseDidKey(recipientDidKey);
  if (jwtAlg !== 'ES256K') throw new Error('Recipient must be a secp256k1 did:key');
  const eph = crypto.createECDH('secp256k1');
  eph.generateKeys();
  const ephPub = eph.getPublicKey(null, 'compressed');
  const shared = eph.computeSecret(Buffer.from(keyBytes));
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, '', INFO, 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(ephPub);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ephPub, iv, cipher.getAuthTag(), body]);
}

export function decryptWithPrivateKey(privateKey: Uint8Array, bundle: Buffer): Buffer {
  if (bundle.length < 33 + 12 + 16) throw new Error('Bundle too short');
  const ephPub = bundle.subarray(0, 33);
  const iv = bundle.subarray(33, 45);
  const tag = bundle.subarray(45, 61);
  const body = bundle.subarray(61);
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(privateKey));
  const shared = ecdh.computeSecret(ephPub);
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, '', INFO, 32));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(ephPub);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
