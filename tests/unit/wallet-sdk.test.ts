import { describe, it, expect } from 'vitest';
import { verifyMessage as verifyEthMessage } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  generateMnemonic,
  isValidMnemonic,
  deriveWallet,
  wrapMnemonic,
  unwrapMnemonic,
  signEthereumMessage,
  signSolanaMessage,
  WalletSession,
} from '../../packages/openfederation-sdk/src/wallet/index.js';
import { mnemonicToSeed } from '../../packages/openfederation-sdk/src/wallet/mnemonic.js';

// SDK-side unit tests: mnemonic generation, HD derivation, passphrase
// wrapping, and chain-native signing helpers. All pure functions — no DB,
// no server.

describe('SDK mnemonic', () => {
  it('generateMnemonic produces a valid 12-word phrase', () => {
    const m = generateMnemonic();
    expect(m.split(/\s+/).length).toBe(12);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it('invalid mnemonic fails validation', () => {
    expect(isValidMnemonic('this is definitely not a valid bip39 phrase here')).toBe(false);
  });
});

describe('SDK HD derivation', () => {
  // BIP-44 test vector: a known mnemonic's ETH address at m/44'/60'/0'/0/0.
  // Ref: https://github.com/ethereum/EIPs/blob/master/EIPS/eip-2334.md
  const vectorMnemonic =
    'test test test test test test test test test test test junk';
  const expectedEthAddress = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

  it('Ethereum derivation matches the published test vector for the Hardhat default mnemonic', () => {
    const seed = mnemonicToSeed(vectorMnemonic);
    const w = deriveWallet('ethereum', seed);
    expect(w.address).toBe(expectedEthAddress);
    expect(w.privateKey.length).toBe(32);
    expect(w.derivationPath).toBe("m/44'/60'/0'/0/0");
  });

  it('Solana derivation is deterministic for a given seed', () => {
    const m = generateMnemonic();
    const seed1 = mnemonicToSeed(m);
    const seed2 = mnemonicToSeed(m);
    const a = deriveWallet('solana', seed1);
    const b = deriveWallet('solana', seed2);
    expect(a.address).toBe(b.address);
    expect(a.privateKey.length).toBe(64);
  });

  it('different chains from the same seed produce different addresses', () => {
    const seed = mnemonicToSeed(generateMnemonic());
    const eth = deriveWallet('ethereum', seed);
    const sol = deriveWallet('solana', seed);
    expect(eth.address).not.toBe(sol.address);
  });
});

describe('SDK signing', () => {
  it('Ethereum signature round-trips through ethers.verifyMessage', () => {
    const seed = mnemonicToSeed(generateMnemonic());
    const w = deriveWallet('ethereum', seed);
    const sig = signEthereumMessage('hello ethereum', w.privateKey);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    const recovered = verifyEthMessage('hello ethereum', sig).toLowerCase();
    expect(recovered).toBe(w.address);
  });

  it('Solana signature verifies via tweetnacl', () => {
    const seed = mnemonicToSeed(generateMnemonic());
    const w = deriveWallet('solana', seed);
    const sig = signSolanaMessage('hola', w.privateKey);
    const msgBytes = new TextEncoder().encode('hola');
    const sigBytes = bs58.decode(sig);
    const pkBytes = bs58.decode(w.address);
    expect(nacl.sign.detached.verify(msgBytes, sigBytes, pkBytes)).toBe(true);
  });
});

describe('SDK wrap/unwrap', () => {
  it('wrapped blob round-trips under the correct passphrase', async () => {
    const m = generateMnemonic();
    const wrapped = await wrapMnemonic(m, 'correct-horse');
    expect(wrapped.v).toBe('1');
    const back = await unwrapMnemonic(wrapped, 'correct-horse');
    expect(back).toBe(m);
  });

  it('wrong passphrase fails', async () => {
    const wrapped = await wrapMnemonic(generateMnemonic(), 'right');
    await expect(unwrapMnemonic(wrapped, 'wrong')).rejects.toThrow();
  });

  it('tampered ciphertext fails', async () => {
    const wrapped = await wrapMnemonic(generateMnemonic(), 'pass');
    wrapped.ct = wrapped.ct.slice(0, -4) + 'XXXX';
    await expect(unwrapMnemonic(wrapped, 'pass')).rejects.toThrow();
  });

  it('rejects empty inputs', async () => {
    await expect(wrapMnemonic('', 'pass')).rejects.toThrow();
    await expect(wrapMnemonic('abc', '')).rejects.toThrow();
  });
});

describe('WalletSession', () => {
  it('derives + caches wallets lazily, signs for multiple chains from one mnemonic', () => {
    const m = generateMnemonic();
    const sess = new WalletSession(m);
    const ethAddr = sess.getAddress('ethereum');
    const solAddr = sess.getAddress('solana');
    expect(ethAddr).toMatch(/^0x[0-9a-f]{40}$/);
    expect(solAddr).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    const ethSig = sess.signMessage('eth msg', 'ethereum');
    const solSig = sess.signMessage('sol msg', 'solana');
    expect(verifyEthMessage('eth msg', ethSig).toLowerCase()).toBe(ethAddr);
    expect(nacl.sign.detached.verify(
      new TextEncoder().encode('sol msg'),
      bs58.decode(solSig),
      bs58.decode(solAddr)
    )).toBe(true);

    sess.destroy();
  });
});
