/**
 * BIP-39 mnemonic helpers. Thin wrapper around @scure/bip39 + English wordlist.
 */

import { generateMnemonic as bip39Generate, mnemonicToSeedSync, validateMnemonic as bip39Validate } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

/** Generate a fresh 12-word mnemonic (128 bits of entropy). */
export function generateMnemonic(strengthBits: 128 | 160 | 192 | 224 | 256 = 128): string {
  return bip39Generate(wordlist, strengthBits);
}

/** Validate a mnemonic against the English wordlist. */
export function isValidMnemonic(mnemonic: string): boolean {
  return bip39Validate(mnemonic, wordlist);
}

/** Derive a 64-byte BIP-39 seed from a mnemonic + optional passphrase. */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Uint8Array {
  return mnemonicToSeedSync(mnemonic, passphrase);
}
