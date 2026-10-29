import { describe, it, expect } from 'vitest';
import { Secp256k1Keypair } from '@atproto/crypto';
import { encryptToDidKey, decryptWithPrivateKey } from '../../src/crypto/ecies.js';

describe('ecies (moved community keys)', () => {
  it('round-trips to the holder of the did:key and to nobody else', async () => {
    const recipient = await Secp256k1Keypair.create({ exportable: true });
    const other = await Secp256k1Keypair.create({ exportable: true });
    const bundle = encryptToDidKey(recipient.did(), Buffer.from('{"keys":[1,2,3]}'));
    expect(decryptWithPrivateKey(await recipient.export(), bundle).toString()).toBe('{"keys":[1,2,3]}');
    const otherKey = await other.export();
    expect(() => decryptWithPrivateKey(otherKey, bundle)).toThrow();
    const tampered = Buffer.from(bundle); tampered[tampered.length - 1] ^= 1;
    const recipientKey = await recipient.export();
    expect(() => decryptWithPrivateKey(recipientKey, tampered)).toThrow();
  });

  it('refuses a non-secp256k1 recipient', () => {
    expect(() => encryptToDidKey('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', Buffer.from('x'))).toThrow();
  });
});
