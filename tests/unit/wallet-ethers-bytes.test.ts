/**
 * signer.signMessage(bytes) must sign those bytes. Decoding them as text first
 * replaces anything that is not valid UTF-8 (which a 32-byte hash almost never
 * is), so the signature was over different data and did not verify.
 */
import { describe, it, expect } from 'vitest';
import { verifyMessage as verifyEthMessage, getBytes, keccak256, toUtf8Bytes } from 'ethers';
import { createEthersSigner } from '../../packages/openfederation-sdk/src/wallet/ethers-adapter.js';
import { WalletSession } from '../../packages/openfederation-sdk/src/wallet/wallet-session.js';
import { generateMnemonic } from '../../packages/openfederation-sdk/src/wallet/mnemonic.js';

describe('OFEthersSigner signMessage with bytes', () => {
  it('signs a 32-byte hash so that ethers verifies it', async () => {
    const session = new WalletSession(generateMnemonic());
    const signer = await createEthersSigner(undefined as never, session.getAddress('ethereum'), session);
    const hash = getBytes(keccak256(toUtf8Bytes('some payload')));

    const sig = await signer.signMessage(hash);
    expect(verifyEthMessage(hash, sig).toLowerCase()).toBe(session.getAddress('ethereum').toLowerCase());
  });

  it('refuses, instead of signing something else, when bytes cannot go through the server as text', async () => {
    const calls: unknown[] = [];
    const client = { wallet: { sign: async (o: unknown) => { calls.push(o); return { signature: '0x' }; } } };
    const signer = await createEthersSigner(client as never, '0x00000000000000000000000000000000000000a1');
    const notUtf8 = new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x81]);

    await expect(signer.signMessage(notUtf8)).rejects.toThrow(/bytes/i);
    expect(calls).toEqual([]);
  });

  it('still sends text bytes through the server as the text they are', async () => {
    const calls: Array<{ message: string }> = [];
    const client = { wallet: { sign: async (o: { message: string }) => { calls.push(o); return { signature: '0xabc' }; } } };
    const signer = await createEthersSigner(client as never, '0x00000000000000000000000000000000000000a1');
    await signer.signMessage(toUtf8Bytes('plain text'));
    expect(calls[0].message).toBe('plain text');
  });
});
