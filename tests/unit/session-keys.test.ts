import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  generateSessionKey,
  encryptWithSessionKey,
  decryptWithSessionKey,
} from '../../src/disclosure/session-keys.js';

describe('Session Keys', () => {
  describe('generateSessionKey', () => {
    it('should produce a 32-byte key', () => {
      const { key, keyHash } = generateSessionKey();
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.length).toBe(32);
      expect(typeof keyHash).toBe('string');
      expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce unique keys', () => {
      const a = generateSessionKey();
      const b = generateSessionKey();
      expect(a.key.equals(b.key)).toBe(false);
      expect(a.keyHash).not.toBe(b.keyHash);
    });

    it('should produce a hash that matches the key', () => {
      const { key, keyHash } = generateSessionKey();
      const expectedHash = crypto.createHash('sha256').update(key).digest('hex');
      expect(keyHash).toBe(expectedHash);
    });
  });

  describe('encryptWithSessionKey / decryptWithSessionKey', () => {
    it('should round-trip encrypt and decrypt', () => {
      const { key } = generateSessionKey();
      const plaintext = JSON.stringify({ role: 'athlete', team: 'Alpha', score: 42 });

      const { ciphertext, iv, authTag } = encryptWithSessionKey(plaintext, key);
      expect(ciphertext).toBeTruthy();
      expect(iv).toBeTruthy();
      expect(authTag).toBeTruthy();

      const decrypted = decryptWithSessionKey(ciphertext, key, iv, authTag);
      expect(decrypted).toBe(plaintext);
    });

    it('should fail to decrypt with wrong key', () => {
      const { key: key1 } = generateSessionKey();
      const { key: key2 } = generateSessionKey();
      const plaintext = 'secret data';

      const encrypted = encryptWithSessionKey(plaintext, key1);
      expect(() =>
        decryptWithSessionKey(encrypted.ciphertext, key2, encrypted.iv, encrypted.authTag)
      ).toThrow();
    });

    it('should fail with tampered ciphertext', () => {
      const { key } = generateSessionKey();
      const encrypted = encryptWithSessionKey('sensitive', key);

      // Tamper with ciphertext
      const tampered = Buffer.from(encrypted.ciphertext, 'base64');
      tampered[0] ^= 0xff;
      const tamperedB64 = tampered.toString('base64');

      expect(() =>
        decryptWithSessionKey(tamperedB64, key, encrypted.iv, encrypted.authTag)
      ).toThrow();
    });

    it('should handle empty string', () => {
      const { key } = generateSessionKey();
      const encrypted = encryptWithSessionKey('', key);
      const decrypted = decryptWithSessionKey(encrypted.ciphertext, key, encrypted.iv, encrypted.authTag);
      expect(decrypted).toBe('');
    });

    it('should handle large payloads', () => {
      const { key } = generateSessionKey();
      const largePayload = 'x'.repeat(100_000);
      const encrypted = encryptWithSessionKey(largePayload, key);
      const decrypted = decryptWithSessionKey(encrypted.ciphertext, key, encrypted.iv, encrypted.authTag);
      expect(decrypted).toBe(largePayload);
    });
  });
});
