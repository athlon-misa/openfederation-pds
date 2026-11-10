/**
 * Rotating KEY_ENCRYPTION_SECRET: during the switch the server decrypts with
 * the current secret or KEY_ENCRYPTION_SECRET_PREVIOUS, and the rotation
 * re-encrypts every stored key under the current one. Afterwards the previous
 * secret is no longer needed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { query } from '../../src/db/client.js';
import { config } from '../../src/config.js';
import { wrapKeyBytes, unwrapKeyBytes } from '../../src/crypto/key-wrap.js';
import { rotateKeyEncryption, ENCRYPTED_KEY_COLUMNS } from '../../src/crypto/rotate-key-encryption.js';

const original = { current: config.keyEncryptionSecret, previous: config.keyEncryptionSecretPrevious };
const OLD = 'old-key-encryption-secret-0123456789abcdef';
const NEW = 'new-key-encryption-secret-fedcba9876543210';

function useSecrets(current: string, previous = '') {
  config.keyEncryptionSecret = current;
  config.keyEncryptionSecretPrevious = previous;
}

afterEach(() => useSecrets(original.current, original.previous));

describe('decrypting during a rotation', () => {
  it('accepts a key wrapped under the previous secret', async () => {
    useSecrets(OLD);
    const wrapped = await wrapKeyBytes(Buffer.from('secret key'), 'identity.signing-key');
    useSecrets(NEW, OLD);
    expect((await unwrapKeyBytes(wrapped, 'identity.signing-key')).toString()).toBe('secret key');
  });

  it('refuses it once the previous secret is gone', async () => {
    useSecrets(OLD);
    const wrapped = await wrapKeyBytes(Buffer.from('secret key'), 'identity.signing-key');
    useSecrets(NEW);
    await expect(unwrapKeyBytes(wrapped, 'identity.signing-key')).rejects.toThrow();
  });

  it('still binds the purpose: a previous-secret key does not open under another purpose', async () => {
    useSecrets(OLD);
    const wrapped = await wrapKeyBytes(Buffer.from('secret key'), 'vault.share');
    useSecrets(NEW, OLD);
    await expect(unwrapKeyBytes(wrapped, 'identity.signing-key')).rejects.toThrow();
  });
});

describe('rotateKeyEncryption', () => {
  it('covers every table that stores a wrapped key', () => {
    const tables = new Set(ENCRYPTED_KEY_COLUMNS.map((c) => c.table));
    for (const t of ['plc_keys', 'signing_keys', 'user_signing_keys', 'reserved_signing_keys', 'ap_signing_keys',
      'pds_service_keys', 'wallet_custody', 'vault_shares', 'attestation_encryption', 'pseudonym_token_keys']) {
      expect(tables.has(t), t).toBe(true);
    }
  });

  it('re-encrypts stored keys under the current secret; dry run changes nothing; running again is a no-op', async () => {
    const did = `did:plc:rot${randomUUID().slice(0, 8)}`;
    const reserved = `did:key:zRot${randomUUID().slice(0, 8)}`;
    const epoch = `9${randomBytes(3).toString('hex').slice(0, 3)}-01`;
    useSecrets(OLD);
    await query('INSERT INTO user_signing_keys (user_did, signing_key_bytes) VALUES ($1, $2)',
      [did, await wrapKeyBytes(Buffer.from('user-signing'), 'identity.signing-key')]);
    await query('INSERT INTO reserved_signing_keys (signing_key, key_bytes) VALUES ($1, $2)',
      [reserved, await wrapKeyBytes(Buffer.from('reserved'), 'identity.signing-key')]);
    await query('INSERT INTO pseudonym_token_keys (epoch, public_spki, private_pkcs8) VALUES ($1, $2, $3)',
      [epoch, Buffer.from('spki'), await wrapKeyBytes(Buffer.from('token-key'), 'pseudonym.token-key')]);

    try {
      useSecrets(NEW, OLD);
      const only = { user_signing_keys: [did], reserved_signing_keys: [reserved], pseudonym_token_keys: [epoch] };
      const dry = await rotateKeyEncryption({ apply: false, only });
      expect(dry.toRotate).toBe(3);
      expect(dry.rotated).toBe(0);

      const applied = await rotateKeyEncryption({ apply: true, only });
      expect(applied.rotated).toBe(3);
      expect(applied.failed).toEqual([]);

      useSecrets(NEW);
      const row = (await query<{ signing_key_bytes: Buffer }>('SELECT signing_key_bytes FROM user_signing_keys WHERE user_did = $1', [did])).rows[0];
      expect((await unwrapKeyBytes(row.signing_key_bytes, 'identity.signing-key')).toString()).toBe('user-signing');
      const tok = (await query<{ private_pkcs8: Buffer }>('SELECT private_pkcs8 FROM pseudonym_token_keys WHERE epoch = $1', [epoch])).rows[0];
      expect((await unwrapKeyBytes(tok.private_pkcs8, 'pseudonym.token-key')).toString()).toBe('token-key');

      useSecrets(NEW, OLD);
      const again = await rotateKeyEncryption({ apply: true, only });
      expect(again.toRotate).toBe(0);
    } finally {
      await query('DELETE FROM user_signing_keys WHERE user_did = $1', [did]);
      await query('DELETE FROM reserved_signing_keys WHERE signing_key = $1', [reserved]);
      await query('DELETE FROM pseudonym_token_keys WHERE epoch = $1', [epoch]);
    }
  });

  it('reports keys that neither secret opens instead of skipping them silently', async () => {
    const did = `did:plc:bad${randomUUID().slice(0, 8)}`;
    useSecrets('some-third-secret-that-nobody-has-anymore');
    await query('INSERT INTO user_signing_keys (user_did, signing_key_bytes) VALUES ($1, $2)',
      [did, await wrapKeyBytes(Buffer.from('lost'), 'identity.signing-key')]);
    try {
      useSecrets(NEW, OLD);
      const r = await rotateKeyEncryption({ apply: true, only: { user_signing_keys: [did] } });
      expect(r.failed.some((f) => f.table === 'user_signing_keys' && f.key === did)).toBe(true);
    } finally {
      await query('DELETE FROM user_signing_keys WHERE user_did = $1', [did]);
    }
  });
});
