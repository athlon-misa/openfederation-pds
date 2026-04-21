import { describe, it, expect } from 'vitest';
import { buildDidAugmentation } from '../../src/identity/did-augment.js';

describe('buildDidAugmentation', () => {
  const did = 'did:plc:alicealicealicealice12';

  it('produces empty arrays when no wallets are given', () => {
    const aug = buildDidAugmentation(did, []);
    expect(aug.verificationMethod).toEqual([]);
    expect(aug.assertionMethod).toEqual([]);
    expect(aug.authentication).toEqual([]);
  });

  it('emits an EcdsaSecp256k1VerificationKey2019 entry for an Ethereum wallet with CAIP-10 account', () => {
    const aug = buildDidAugmentation(did, [
      { chain: 'ethereum', walletAddress: '0xabc1234567890abc1234567890abc1234567890a', isPrimary: true },
    ]);
    expect(aug.verificationMethod).toHaveLength(1);
    const vm = aug.verificationMethod[0];
    expect(vm.type).toBe('EcdsaSecp256k1VerificationKey2019');
    expect(vm.controller).toBe(did);
    expect(vm.id).toBe(`${did}#wallet-ethereum`);  // primary → short fragment
    expect(vm.blockchainAccountId).toBe('eip155:1:0xabc1234567890abc1234567890abc1234567890a');
    expect(aug.assertionMethod).toContain(vm.id);
    expect(aug.authentication).toContain(vm.id);
  });

  it('emits an Ed25519VerificationKey2020 entry for a Solana wallet', () => {
    const aug = buildDidAugmentation(did, [
      { chain: 'solana', walletAddress: '9xCcaBZxp3sYjoeURVq6W7C7Ce9A5LAc8o6hAj4v4Fjs', isPrimary: true },
    ]);
    const vm = aug.verificationMethod[0];
    expect(vm.type).toBe('Ed25519VerificationKey2020');
    expect(vm.blockchainAccountId).toBe('solana:mainnet:9xCcaBZxp3sYjoeURVq6W7C7Ce9A5LAc8o6hAj4v4Fjs');
  });

  it('honors explicit chainIdCaip2 override (e.g. Polygon)', () => {
    const aug = buildDidAugmentation(did, [
      {
        chain: 'ethereum',
        walletAddress: '0xfedcba0987654321fedcba0987654321fedcba09',
        chainIdCaip2: 'eip155:137',
        isPrimary: true,
      },
    ]);
    expect(aug.verificationMethod[0].blockchainAccountId).toBe('eip155:137:0xfedcba0987654321fedcba0987654321fedcba09');
  });

  it('disambiguates non-primary entries by address fragment', () => {
    const aug = buildDidAugmentation(did, [
      { chain: 'ethereum', walletAddress: '0x1111111111111111111111111111111111111111', isPrimary: true },
      { chain: 'ethereum', walletAddress: '0x2222222222222222222222222222222222222222', isPrimary: false },
    ]);
    const ids = aug.verificationMethod.map((vm) => vm.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(`${did}#wallet-ethereum`);       // primary
    expect(ids).toContain(`${did}#wallet-ethereum-22222222`); // disambiguated
  });

  it('handles mixed-chain portfolios', () => {
    const aug = buildDidAugmentation(did, [
      { chain: 'ethereum', walletAddress: '0xaabb', isPrimary: true },
      { chain: 'solana', walletAddress: 'SoLaNaPk', isPrimary: true },
    ]);
    expect(aug.verificationMethod.map((vm) => vm.type)).toEqual([
      'EcdsaSecp256k1VerificationKey2019',
      'Ed25519VerificationKey2020',
    ]);
  });
});
