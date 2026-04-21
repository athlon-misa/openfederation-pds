import { describe, it, expect } from 'vitest';
import { Wallet, verifyMessage } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { generateWallet } from '../../src/wallet/custody.js';
import { normalizeDappOrigin } from '../../src/wallet/consent.js';
import { isWalletChain, isCustodyTier } from '../../src/wallet/types.js';

// Unit tests for the pure (non-DB) parts of the wallet module: key
// generation correctness and consent-origin normalization.

describe('wallet type guards', () => {
  it('isWalletChain accepts known chains', () => {
    expect(isWalletChain('ethereum')).toBe(true);
    expect(isWalletChain('solana')).toBe(true);
    expect(isWalletChain('bitcoin')).toBe(false);
    expect(isWalletChain('')).toBe(false);
    expect(isWalletChain(undefined)).toBe(false);
  });

  it('isCustodyTier accepts the three tiers', () => {
    expect(isCustodyTier('custodial')).toBe(true);
    expect(isCustodyTier('user_encrypted')).toBe(true);
    expect(isCustodyTier('self_custody')).toBe(true);
    expect(isCustodyTier('Tier 1')).toBe(false);
    expect(isCustodyTier(null)).toBe(false);
  });
});

describe('generateWallet', () => {
  it('Ethereum wallet: address is a valid 0x-prefixed 20-byte hex, lowercased', () => {
    const w = generateWallet('ethereum');
    expect(w.chain).toBe('ethereum');
    expect(w.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(w.privateKey).toBeInstanceOf(Buffer);
    expect(w.privateKey.length).toBe(32);
  });

  it('Ethereum private key recovers the published address', () => {
    const w = generateWallet('ethereum');
    const wallet = new Wallet('0x' + w.privateKey.toString('hex'));
    expect(wallet.address.toLowerCase()).toBe(w.address);
  });

  it('Ethereum wallet can sign a message that verifies against its address', async () => {
    const w = generateWallet('ethereum');
    const signer = new Wallet('0x' + w.privateKey.toString('hex'));
    const sig = await signer.signMessage('hello world');
    expect(verifyMessage('hello world', sig).toLowerCase()).toBe(w.address);
  });

  it('Solana wallet: address is valid base58, private key is 64 bytes', () => {
    const w = generateWallet('solana');
    expect(w.chain).toBe('solana');
    expect(w.privateKey.length).toBe(64);
    // Public key (bytes 32..64) matches the base58-decoded address
    const decoded = bs58.decode(w.address);
    expect(decoded.length).toBe(32);
    expect(Buffer.from(decoded).equals(w.privateKey.subarray(32))).toBe(true);
  });

  it('Solana wallet can sign a message that verifies against its address', () => {
    const w = generateWallet('solana');
    const msg = new TextEncoder().encode('hello world');
    const sig = nacl.sign.detached(msg, new Uint8Array(w.privateKey));
    const pk = bs58.decode(w.address);
    expect(nacl.sign.detached.verify(msg, sig, pk)).toBe(true);
  });

  it('throws on unknown chain', () => {
    expect(() => generateWallet('bitcoin' as any)).toThrow(/Unsupported chain/);
  });

  it('each call produces a distinct keypair', () => {
    const a = generateWallet('ethereum');
    const b = generateWallet('ethereum');
    expect(a.address).not.toBe(b.address);
    expect(a.privateKey.equals(b.privateKey)).toBe(false);
  });
});

describe('normalizeDappOrigin', () => {
  it('lowercases host, preserves protocol, strips path', () => {
    expect(normalizeDappOrigin('https://Example.COM/foo/bar')).toBe('https://example.com');
  });

  it('preserves non-default ports', () => {
    expect(normalizeDappOrigin('https://example.com:8443/x')).toBe('https://example.com:8443');
    expect(normalizeDappOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => normalizeDappOrigin('file:///etc/passwd')).toThrow(/http or https/);
    expect(() => normalizeDappOrigin('javascript:alert(1)')).toThrow();
  });

  it('rejects malformed input', () => {
    expect(() => normalizeDappOrigin('')).toThrow();
    expect(() => normalizeDappOrigin('not a url')).toThrow();
    expect(() => normalizeDappOrigin(undefined as any)).toThrow();
  });

  it('is idempotent on already-canonical origins', () => {
    const canonical = 'https://game.example.com';
    expect(normalizeDappOrigin(canonical)).toBe(canonical);
    expect(normalizeDappOrigin(normalizeDappOrigin(canonical))).toBe(canonical);
  });
});
