/**
 * Custody upgrades in the SDK must never leave a wallet without a usable key.
 */
import { describe, it, expect } from 'vitest';
import { verifyMessage as verifyEthMessage } from 'ethers';
import {
  generateMnemonic, mnemonicToSeed, deriveWallet, wrapMnemonic, sessionFromWrappedSecret,
} from '../../packages/openfederation-sdk/src/wallet/index.js';
import { upgradeToTier } from '../../packages/openfederation-sdk/src/wallet/upgrade.js';

function tier1EthereumWallet() {
  // What the server holds for a Tier 1 wallet: a raw key, exported as base64.
  const wallet = deriveWallet('ethereum', mnemonicToSeed(generateMnemonic()));
  return { address: wallet.address, privateKeyBase64: Buffer.from(wallet.privateKey).toString('base64') };
}

describe('Tier 1 to Tier 2 upgrade', () => {
  it('produces a secret the SDK can unlock and sign with, for the same address', async () => {
    const wallet = tier1EthereumWallet();
    let storedBlob = '';
    await upgradeToTier({
      retrieveForUpgrade: async () => ({ privateKeyBase64: wallet.privateKeyBase64, exportFormat: 'raw-secp256k1-32-bytes' }),
      finalizeTierChange: async (o) => { storedBlob = o.newEncryptedBlob ?? ''; return { previousTier: 'custodial', newTier: o.newTier }; },
    }, {
      chain: 'ethereum', walletAddress: wallet.address, newTier: 'user_encrypted',
      currentPassword: 'pw', newPassphrase: 'correct horse battery', currentTier: 'custodial',
    });

    const session = await sessionFromWrappedSecret(storedBlob, 'correct horse battery', 'ethereum');
    expect(session.getAddress('ethereum').toLowerCase()).toBe(wallet.address.toLowerCase());
    const signature = session.signMessage('hello', 'ethereum');
    expect(verifyEthMessage('hello', signature).toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('a secret written by the older upgrade (raw key, no marker) can still be unlocked', async () => {
    const wallet = tier1EthereumWallet();
    const legacyBlob = JSON.stringify(await wrapMnemonic(wallet.privateKeyBase64, 'correct horse battery'));
    const session = await sessionFromWrappedSecret(legacyBlob, 'correct horse battery', 'ethereum');
    expect(session.getAddress('ethereum').toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('a mnemonic secret still unlocks as before', async () => {
    const mnemonic = generateMnemonic();
    const expected = deriveWallet('ethereum', mnemonicToSeed(mnemonic)).address;
    const blob = JSON.stringify(await wrapMnemonic(mnemonic, 'pass phrase 123'));
    const session = await sessionFromWrappedSecret(blob, 'pass phrase 123', 'ethereum');
    expect(session.getAddress('ethereum')).toBe(expected);
  });
});

describe('Tier 2 to Tier 3 upgrade', () => {
  const baseOpts = {
    chain: 'ethereum' as const, newTier: 'self_custody' as const, currentPassword: 'pw', currentTier: 'user_encrypted' as const,
  };

  it('does not delete the server copy when the passphrase is wrong', async () => {
    const mnemonic = generateMnemonic();
    const address = deriveWallet('ethereum', mnemonicToSeed(mnemonic)).address;
    const blob = JSON.stringify(await wrapMnemonic(mnemonic, 'the right passphrase'));
    let finalized = false;
    await expect(upgradeToTier({
      retrieveForUpgrade: async () => { throw new Error('not used'); },
      finalizeTierChange: async (o) => { finalized = true; return { previousTier: 'user_encrypted', newTier: o.newTier }; },
      getCustodialSecret: async () => ({ encryptedBlob: blob, walletAddress: address }),
    }, { ...baseOpts, walletAddress: address, tier2Passphrase: 'a wrong passphrase' })).rejects.toThrow();
    expect(finalized).toBe(false);
  });

  it('does not delete the server copy when no passphrase is given', async () => {
    let finalized = false;
    await expect(upgradeToTier({
      retrieveForUpgrade: async () => { throw new Error('not used'); },
      finalizeTierChange: async (o) => { finalized = true; return { previousTier: 'user_encrypted', newTier: o.newTier }; },
      getCustodialSecret: async () => ({ encryptedBlob: '{}', walletAddress: '0x0' }),
    }, { ...baseOpts, walletAddress: '0x0' })).rejects.toThrow(/passphrase/i);
    expect(finalized).toBe(false);
  });

  it('with the right passphrase, hands the secret to the caller and then drops the server copy', async () => {
    const mnemonic = generateMnemonic();
    const address = deriveWallet('ethereum', mnemonicToSeed(mnemonic)).address;
    const blob = JSON.stringify(await wrapMnemonic(mnemonic, 'the right passphrase'));
    let finalized = false;
    const result = await upgradeToTier({
      retrieveForUpgrade: async () => { throw new Error('not used'); },
      finalizeTierChange: async (o) => { finalized = true; return { previousTier: 'user_encrypted', newTier: o.newTier }; },
      getCustodialSecret: async () => ({ encryptedBlob: blob, walletAddress: address }),
    }, { ...baseOpts, walletAddress: address, tier2Passphrase: 'the right passphrase' });
    expect(finalized).toBe(true);
    expect(result.exportedSecret).toBe(mnemonic);
    expect(result.exportedSecretKind).toBe('mnemonic');
  });
});
