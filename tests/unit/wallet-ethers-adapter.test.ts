import { describe, it, expect } from 'vitest';
import { Transaction as EthersTransaction, verifyMessage as verifyEthMessage } from 'ethers';
import { createEthersSigner } from '../../packages/openfederation-sdk/src/wallet/ethers-adapter.js';
import { WalletSession } from '../../packages/openfederation-sdk/src/wallet/wallet-session.js';
import { generateMnemonic } from '../../packages/openfederation-sdk/src/wallet/mnemonic.js';
import { createSolanaSigner } from '../../packages/openfederation-sdk/src/wallet/solana-adapter.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// These tests exercise the adapter for Tier 2 (unlocked WalletSession) —
// signing happens fully client-side, no server. Tier 1 adapter paths are
// covered implicitly by wallet-signTransaction.test.ts.

describe('OFEthersSigner (Tier 2 — client-side)', () => {
  it('getAddress + signMessage + signTransaction round-trip via ethers.verify*', async () => {
    const session = new WalletSession(generateMnemonic());
    // Pass undefined for the client since Tier 2 never hits the server.
    const signer = await createEthersSigner(
      undefined as never,
      session.getAddress('ethereum'),
      session
    );

    const address = await signer.getAddress();
    expect(address).toBe(session.getAddress('ethereum'));

    // signMessage → ethers.verifyMessage recovers the same address.
    const sig = await signer.signMessage('hello from OF signer');
    expect(verifyEthMessage('hello from OF signer', sig).toLowerCase()).toBe(address);

    // signTransaction → parsed tx's `from` matches.
    const signed = await signer.signTransaction({
      to: '0x0000000000000000000000000000000000000042',
      value: 1000n,
      gasLimit: 21000n,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      nonce: 0,
      chainId: 1,
    });
    const parsed = EthersTransaction.from(signed);
    expect(parsed.from?.toLowerCase()).toBe(address);
    expect(parsed.chainId).toBe(1n);

    session.destroy();
  });

  it('signTypedData throws until M3 implements EIP-712', async () => {
    const session = new WalletSession(generateMnemonic());
    const signer = await createEthersSigner(
      undefined as never,
      session.getAddress('ethereum'),
      session
    );
    await expect(
      signer.signTypedData(
        { name: 'Test', version: '1', chainId: 1, verifyingContract: '0x0000000000000000000000000000000000000000' },
        { Person: [{ name: 'name', type: 'string' }] },
        { name: 'alice' }
      )
    ).rejects.toThrow(/EIP-712|not yet supported/i);
    session.destroy();
  });
});

describe('OFSolanaSigner (Tier 2 — client-side)', () => {
  it('signMessage + signTransactionMessage produce valid Ed25519 signatures', async () => {
    const session = new WalletSession(generateMnemonic());
    const address = session.getAddress('solana');
    const signer = createSolanaSigner(undefined as never, address, session);

    expect(signer.walletAddress).toBe(address);
    expect(signer.tier).toBe('user_encrypted');

    const msgBytes = new TextEncoder().encode('ping solana');
    const sigBytes = await signer.signMessage(msgBytes);
    expect(nacl.sign.detached.verify(msgBytes, sigBytes, bs58.decode(address))).toBe(true);

    // signTransactionMessage with a Transaction-like object.
    const fakeTx = {
      serializeMessage: () => new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    };
    const txSigB58 = await signer.signTransactionMessage(fakeTx);
    const txSigBytes = bs58.decode(txSigB58);
    expect(nacl.sign.detached.verify(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), txSigBytes, bs58.decode(address))).toBe(true);

    session.destroy();
  });

  it('works with VersionedTransaction-style shape (message.serialize)', async () => {
    const session = new WalletSession(generateMnemonic());
    const address = session.getAddress('solana');
    const signer = createSolanaSigner(undefined as never, address, session);

    const fakeVTx = {
      message: { serialize: () => new Uint8Array([0x01, 0x23, 0x45, 0x67]) },
    };
    const sigB58 = await signer.signTransactionMessage(fakeVTx);
    expect(nacl.sign.detached.verify(new Uint8Array([0x01, 0x23, 0x45, 0x67]), bs58.decode(sigB58), bs58.decode(address))).toBe(true);

    session.destroy();
  });

  it('rejects unknown transaction shapes', async () => {
    const session = new WalletSession(generateMnemonic());
    const signer = createSolanaSigner(undefined as never, session.getAddress('solana'), session);
    await expect(signer.signTransactionMessage({} as any)).rejects.toThrow(/Unsupported Solana transaction/);
    session.destroy();
  });
});
