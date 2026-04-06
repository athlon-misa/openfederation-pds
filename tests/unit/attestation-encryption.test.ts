import { describe, it, expect } from 'vitest';
import {
  generateDEK,
  encryptClaim,
  decryptClaim,
  createCommitment,
  wrapDEK,
  unwrapDEK,
} from '../../src/attestation/encryption.js';

describe('Attestation Encryption', () => {
  describe('generateDEK', () => {
    it('should return a 32-byte buffer', () => {
      const dek = generateDEK();
      expect(Buffer.isBuffer(dek)).toBe(true);
      expect(dek.length).toBe(32);
    });

    it('should generate unique keys', () => {
      const dek1 = generateDEK();
      const dek2 = generateDEK();
      expect(dek1.equals(dek2)).toBe(false);
    });
  });

  describe('encryptClaim / decryptClaim', () => {
    it('should round-trip encrypt and decrypt preserving data', () => {
      const dek = generateDEK();
      const claim = { role: 'athlete', position: 'Forward', number: 10 };
      const encrypted = encryptClaim(claim, dek);
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.authTag).toBeTruthy();

      const decrypted = decryptClaim(encrypted.ciphertext, dek, encrypted.iv, encrypted.authTag);
      expect(decrypted).toEqual(claim);
    });

    it('should produce different ciphertext for same claim with different DEKs', () => {
      const claim = { role: 'moderator' };
      const enc1 = encryptClaim(claim, generateDEK());
      const enc2 = encryptClaim(claim, generateDEK());
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    });

    it('should fail to decrypt with wrong DEK', () => {
      const claim = { secret: 'data' };
      const dek1 = generateDEK();
      const dek2 = generateDEK();
      const encrypted = encryptClaim(claim, dek1);
      expect(() =>
        decryptClaim(encrypted.ciphertext, dek2, encrypted.iv, encrypted.authTag)
      ).toThrow();
    });
  });

  describe('createCommitment', () => {
    it('should produce a deterministic hash', () => {
      const claim = { role: 'athlete', team: 'Alpha' };
      const c1 = createCommitment(claim);
      const c2 = createCommitment(claim);
      expect(c1.hash).toBe(c2.hash);
    });

    it('should produce a different hash when data changes', () => {
      const c1 = createCommitment({ role: 'athlete' });
      const c2 = createCommitment({ role: 'moderator' });
      expect(c1.hash).not.toBe(c2.hash);
    });

    it('should produce a 64-char hex string (SHA-256)', () => {
      const c = createCommitment({ test: true });
      expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should be consistent regardless of property insertion order', () => {
      // createCommitment sorts keys, so insertion order should not matter
      const c1 = createCommitment({ a: 1, b: 2 });
      const c2 = createCommitment({ b: 2, a: 1 });
      expect(c1.hash).toBe(c2.hash);
    });
  });

  describe('wrapDEK / unwrapDEK', () => {
    it('should round-trip wrap and unwrap a DEK', async () => {
      const dek = generateDEK();
      const wrapped = await wrapDEK(dek);
      expect(typeof wrapped).toBe('string');
      expect(wrapped.length).toBeGreaterThan(0);

      const unwrapped = await unwrapDEK(wrapped);
      expect(unwrapped.equals(dek)).toBe(true);
    });

    it('should produce different wrapped outputs for same DEK (random salt)', async () => {
      const dek = generateDEK();
      const w1 = await wrapDEK(dek);
      const w2 = await wrapDEK(dek);
      expect(w1).not.toBe(w2);
    });
  });
});
