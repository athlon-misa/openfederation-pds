import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { verifyEthereumSignature } from '../../src/identity/adapters/ethereum-verifier.js';
import { verifySolanaSignature } from '../../src/identity/adapters/solana-verifier.js';

describe('Ethereum Signature Verifier', () => {
  it('should verify a valid Ethereum signature', async () => {
    const wallet = Wallet.createRandom();
    const message = 'OpenFederation Wallet Link\nNonce: abc123';
    const signature = await wallet.signMessage(message);

    const result = await verifyEthereumSignature(message, signature, wallet.address);
    expect(result).toBe(true);
  });

  it('should reject a signature from a different wallet', async () => {
    const wallet1 = Wallet.createRandom();
    const wallet2 = Wallet.createRandom();
    const message = 'OpenFederation Wallet Link\nNonce: abc123';
    const signature = await wallet1.signMessage(message);

    const result = await verifyEthereumSignature(message, signature, wallet2.address);
    expect(result).toBe(false);
  });

  it('should reject a corrupted signature', async () => {
    const wallet = Wallet.createRandom();
    const message = 'Test message';
    const result = await verifyEthereumSignature(message, '0xinvalid', wallet.address);
    expect(result).toBe(false);
  });

  it('should be case-insensitive for addresses', async () => {
    const wallet = Wallet.createRandom();
    const message = 'Case test';
    const signature = await wallet.signMessage(message);

    const result = await verifyEthereumSignature(
      message,
      signature,
      wallet.address.toUpperCase()
    );
    expect(result).toBe(true);
  });
});

describe('Solana Signature Verifier', () => {
  it('should verify a valid Solana signature', async () => {
    const keypair = nacl.sign.keyPair();
    const walletAddress = bs58.encode(keypair.publicKey);
    const message = 'OpenFederation Wallet Link\nNonce: sol123';
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
    const signatureBase58 = bs58.encode(signatureBytes);

    const result = await verifySolanaSignature(message, signatureBase58, walletAddress);
    expect(result).toBe(true);
  });

  it('should reject a signature from a different keypair', async () => {
    const keypair1 = nacl.sign.keyPair();
    const keypair2 = nacl.sign.keyPair();
    const walletAddress2 = bs58.encode(keypair2.publicKey);
    const message = 'OpenFederation Wallet Link\nNonce: sol123';
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = nacl.sign.detached(messageBytes, keypair1.secretKey);
    const signatureBase58 = bs58.encode(signatureBytes);

    const result = await verifySolanaSignature(message, signatureBase58, walletAddress2);
    expect(result).toBe(false);
  });

  it('should reject a corrupted signature', async () => {
    const keypair = nacl.sign.keyPair();
    const walletAddress = bs58.encode(keypair.publicKey);
    const message = 'Test message';
    const result = await verifySolanaSignature(message, 'invalidbase58sig', walletAddress);
    expect(result).toBe(false);
  });
});
