/**
 * Phrase → keys for `assisted` and `self` accounts (ADR-003, decision 3).
 * A device-generated 12-word BIP-39 phrase derives two secp256k1 keys:
 *   - the PLC rotation key at m/1985'/0' (controls the DID),
 *   - the owner key at m/1985'/1' (signs person-level statements).
 * The phrase never leaves the device; only the did:keys do.
 * (Pseudonyms use m/1984'/0' from their own phrase, so the two never collide.)
 */
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1';
import { didKeyFor } from './encoding.js';

export const ROTATION_KEY_PATH = "m/1985'/0'";
export const OWNER_KEY_PATH = "m/1985'/1'";

export interface CustodyKeys {
  rotationPrivateKey: Uint8Array;
  rotationDidKey: string;
  ownerPrivateKey: Uint8Array;
  ownerDidKey: string;
}

/** A fresh 12-word phrase (128 bits). Show it to the person once; keep it on paper. */
export function generateCustodyPhrase(): string {
  return generateMnemonic(wordlist, 128);
}

export function normalizePhrase(phrase: string): string {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (normalized.split(' ').length !== 12 || !validateMnemonic(normalized, wordlist)) throw new Error('InvalidPhrase');
  return normalized;
}

export function deriveCustodyKeys(phrase: string): CustodyKeys {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(normalizePhrase(phrase), ''));
  const rotation = root.derive(ROTATION_KEY_PATH).privateKey;
  const owner = root.derive(OWNER_KEY_PATH).privateKey;
  if (!rotation || !owner) throw new Error('InvalidPhrase');
  return {
    rotationPrivateKey: rotation,
    rotationDidKey: didKeyFor('secp256k1', secp256k1.getPublicKey(rotation, true)),
    ownerPrivateKey: owner,
    ownerDidKey: didKeyFor('secp256k1', secp256k1.getPublicKey(owner, true)),
  };
}
