import { describe, it, expect } from 'vitest';
import { Transaction as EthersTransaction, verifyMessage as verifyEthMessage } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  generateMnemonic,
  deriveWallet,
  signEthereumTransaction,
  signSolanaTransactionMessage,
  WalletSession,
} from '../../packages/openfederation-sdk/src/wallet/index.js';
import { mnemonicToSeed } from '../../packages/openfederation-sdk/src/wallet/mnemonic.js';
import { normalizeEvmTxForWire } from '../../packages/openfederation-sdk/src/wallet/tx-normalize.js';

describe('SDK transaction signing', () => {
  describe('Ethereum', () => {
    it('signEthereumTransaction produces a signed RLP hex whose recovered signer matches the derived address', async () => {
      const seed = mnemonicToSeed(generateMnemonic());
      const w = deriveWallet('ethereum', seed);
      const signed = await signEthereumTransaction(w.privateKey, {
        to: '0x0000000000000000000000000000000000000001',
        value: '1000000000000000',
        gasLimit: '21000',
        maxFeePerGas: '30000000000',
        maxPriorityFeePerGas: '1000000000',
        nonce: 0,
        chainId: 1,
      });
      expect(signed).toMatch(/^0x[0-9a-f]+$/);
      const parsed = EthersTransaction.from(signed);
      expect(parsed.from?.toLowerCase()).toBe(w.address);
      expect(parsed.chainId).toBe(1n);
      expect(parsed.value).toBe(1_000_000_000_000_000n);
    });

    it('refuses to sign without chainId (replay protection)', async () => {
      const seed = mnemonicToSeed(generateMnemonic());
      const w = deriveWallet('ethereum', seed);
      await expect(
        signEthereumTransaction(w.privateKey, { to: '0x0', chainId: undefined as any })
      ).rejects.toThrow(/chainId/);
    });

    it('WalletSession.signEthereumTransaction round-trips', async () => {
      const m = generateMnemonic();
      const session = new WalletSession(m);
      const signed = await session.signEthereumTransaction({
        to: '0x0000000000000000000000000000000000000002',
        value: '500',
        gasLimit: '21000',
        maxFeePerGas: '20000000000',
        maxPriorityFeePerGas: '1000000000',
        nonce: 0,
        chainId: 137,
      });
      const parsed = EthersTransaction.from(signed);
      expect(parsed.chainId).toBe(137n);
      expect(parsed.from?.toLowerCase()).toBe(session.getAddress('ethereum'));
      // Sanity: non-tx message signing still works after tx signing.
      const msgSig = session.signMessage('hi', 'ethereum');
      expect(verifyEthMessage('hi', msgSig).toLowerCase()).toBe(session.getAddress('ethereum'));
      session.destroy();
    });
  });

  describe('Solana', () => {
    it('signSolanaTransactionMessage produces an Ed25519 signature over the bytes', () => {
      const seed = mnemonicToSeed(generateMnemonic());
      const w = deriveWallet('solana', seed);
      const messageBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
      const sigB58 = signSolanaTransactionMessage(w.privateKey, messageBytes);
      const sigBytes = bs58.decode(sigB58);
      const pkBytes = bs58.decode(w.address);
      expect(nacl.sign.detached.verify(messageBytes, sigBytes, pkBytes)).toBe(true);
    });

    it('accepts a 32-byte seed or 64-byte secret key', () => {
      const seed32 = new Uint8Array(32);
      for (let i = 0; i < 32; i++) seed32[i] = i + 1;
      const kp = nacl.sign.keyPair.fromSeed(seed32);
      const msg = new Uint8Array([9, 8, 7]);

      const s1 = signSolanaTransactionMessage(seed32, msg);
      const s2 = signSolanaTransactionMessage(kp.secretKey, msg);
      // Both produce the same deterministic Ed25519 signature.
      expect(s1).toBe(s2);
    });

    it('WalletSession.signSolanaTransactionMessage matches the derived key', () => {
      const m = generateMnemonic();
      const session = new WalletSession(m);
      const msgBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const sigB58 = session.signSolanaTransactionMessage(msgBytes);
      const valid = nacl.sign.detached.verify(
        msgBytes,
        bs58.decode(sigB58),
        bs58.decode(session.getAddress('solana'))
      );
      expect(valid).toBe(true);
      session.destroy();
    });
  });

  describe('EVM tx normalization for wire transport', () => {
    it('stringifies bigint fields and keeps numbers for chainId / nonce', () => {
      const out = normalizeEvmTxForWire({
        to: '0xabc',
        value: 1_000_000n,
        gasLimit: 21000,
        maxFeePerGas: 30_000_000_000n,
        chainId: 1,
        nonce: 5,
        data: '0x',
      });
      expect(out.value).toBe('1000000');
      expect(out.gasLimit).toBe('21000');
      expect(out.maxFeePerGas).toBe('30000000000');
      expect(out.chainId).toBe(1);
      expect(out.nonce).toBe(5);
      expect(out.to).toBe('0xabc');
      expect(out.data).toBe('0x');
    });

    it('drops null/undefined fields', () => {
      const out = normalizeEvmTxForWire({ to: '0x1', value: undefined, data: null, chainId: 1 });
      expect('value' in out).toBe(false);
      expect('data' in out).toBe(false);
      expect(out.chainId).toBe(1);
    });
  });
});
