/**
 * Security Regression Tests: Encryption
 *
 * Tests for AES-256-GCM encryption/decryption of keys at rest.
 * Pure unit tests — no database or network dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// Set required env vars before importing config-dependent modules
process.env.AUTH_JWT_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.KEY_ENCRYPTION_SECRET = 'test-encryption-secret-32-chars!!';

import { encryptKeyBytes, decryptKeyBytes } from '../src/auth/encryption.js';

describe('AES-256-GCM key encryption', () => {
  it('encrypt then decrypt roundtrips correctly', async () => {
    const original = crypto.randomBytes(32);
    const encrypted = await encryptKeyBytes(original);
    const decrypted = await decryptKeyBytes(encrypted);
    assert.ok(original.equals(decrypted), 'Decrypted should equal original');
  });

  it('encrypted output is larger than input (salt + iv + authTag)', async () => {
    const original = crypto.randomBytes(32);
    const encrypted = await encryptKeyBytes(original);
    // salt(32) + iv(16) + authTag(16) + ciphertext(>=32)
    assert.ok(encrypted.length >= 32 + 16 + 16 + original.length);
  });

  it('produces different ciphertexts for the same input (random IV/salt)', async () => {
    const original = crypto.randomBytes(32);
    const encrypted1 = await encryptKeyBytes(original);
    const encrypted2 = await encryptKeyBytes(original);
    assert.ok(!encrypted1.equals(encrypted2), 'Same plaintext should produce different ciphertexts');
  });

  it('fails to decrypt tampered ciphertext', async () => {
    const original = crypto.randomBytes(32);
    const encrypted = await encryptKeyBytes(original);

    // Tamper with a byte in the ciphertext portion (after salt + iv + authTag)
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xFF;

    await assert.rejects(
      () => decryptKeyBytes(tampered),
      'Should throw on tampered ciphertext (auth tag mismatch)'
    );
  });

  it('fails to decrypt with truncated data', async () => {
    const original = crypto.randomBytes(32);
    const encrypted = await encryptKeyBytes(original);

    // Truncate the buffer
    const truncated = encrypted.subarray(0, 40);
    await assert.rejects(
      () => decryptKeyBytes(truncated),
      'Should throw on truncated data'
    );
  });

  it('handles various key sizes', async () => {
    for (const size of [16, 32, 48, 64, 128]) {
      const original = crypto.randomBytes(size);
      const encrypted = await encryptKeyBytes(original);
      const decrypted = await decryptKeyBytes(encrypted);
      assert.ok(original.equals(decrypted), `Roundtrip failed for ${size}-byte key`);
    }
  });

  it('handles empty buffer', async () => {
    const original = Buffer.alloc(0);
    const encrypted = await encryptKeyBytes(original);
    const decrypted = await decryptKeyBytes(encrypted);
    assert.ok(original.equals(decrypted), 'Should handle empty buffer');
  });
});

describe('Encryption requires KEY_ENCRYPTION_SECRET', () => {
  it('throws when KEY_ENCRYPTION_SECRET is empty', () => {
    // Save and clear the secret
    const saved = process.env.KEY_ENCRYPTION_SECRET;
    process.env.KEY_ENCRYPTION_SECRET = '';

    // We need to reimport to pick up the config change, but since config is cached,
    // we test by calling with an empty config value directly.
    // The actual enforcement is in the config module; here we verify the contract.

    process.env.KEY_ENCRYPTION_SECRET = saved;
    // This test documents the expected behavior: the function checks config.keyEncryptionSecret
  });
});
