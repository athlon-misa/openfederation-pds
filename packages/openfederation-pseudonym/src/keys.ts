/**
 * Phrase → pseudonym keys. The phrase is the pseudonym: it derives the owner
 * key (the DID's only PLC rotation key) and the commitment salt. Only the
 * public key ever leaves the device.
 */
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import bs58 from 'bs58';
import { base64UrlEncode } from './formats.js';

export const OWNER_KEY_PATH = "m/1984'/0'";

export interface PseudonymKeys {
  ownerPrivateKey: Uint8Array;
  ownerDidKey: string;
  commitmentSaltHex: string;
}

/**
 * Words a generated phrase never contains. They sound like cryptocurrency,
 * money or security jargon, which would mislead the people pseudonyms are for.
 * Generation simply draws again, so every phrase is still a standard BIP-39
 * phrase; the cost is well under one bit of strength.
 */
export const PHRASE_AVOID_WORDS: ReadonlySet<string> = new Set([
  'satoshi', 'coin', 'token', 'exchange', 'trade', 'stock', 'cash', 'profit', 'fee', 'gas',
  'bid', 'sell', 'market', 'price', 'loan', 'crash', 'bubble', 'moon', 'whale', 'gold',
  'silver', 'rich', 'wealth', 'invest', 'credit', 'fork', 'asset', 'digital', 'address',
  'private', 'public', 'key', 'seed', 'lottery', 'casino', 'bonus', 'reward', 'pool',
  'swap', 'rocket', 'gain', 'vault', 'proof', 'code', 'secret', 'sign', 'bitter',
]);

export function generatePseudonymPhrase(): string {
  for (;;) {
    const phrase = generateMnemonic(wordlist, 128);
    if (!phrase.split(' ').some((w) => PHRASE_AVOID_WORDS.has(w))) return phrase;
  }
}

export function derivePseudonymKeys(phrase: string): PseudonymKeys {
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (normalized.split(' ').length !== 12 || !validateMnemonic(normalized, wordlist)) {
    throw new Error('InvalidPhrase');
  }
  const seed = mnemonicToSeedSync(normalized, '');
  const node = HDKey.fromMasterSeed(seed).derive(OWNER_KEY_PATH);
  if (!node.privateKey) throw new Error('InvalidPhrase');
  const salt = hkdf(sha256, seed, utf8ToBytes('openfederation-pseudonym'), utf8ToBytes('commitment-salt-v1'), 32);
  return {
    ownerPrivateKey: node.privateKey,
    ownerDidKey: secp256k1DidKey(secp256k1.getPublicKey(node.privateKey, true)),
    commitmentSaltHex: bytesToHex(salt),
  };
}

export function secp256k1DidKey(compressedPublicKey: Uint8Array): string {
  const bytes = new Uint8Array(2 + compressedPublicKey.length);
  bytes.set([0xe7, 0x01]);
  bytes.set(compressedPublicKey, 2);
  return `did:key:z${bs58.encode(bytes)}`;
}

export function signBytes(privateKey: Uint8Array, data: Uint8Array): string {
  return base64UrlEncode(secp256k1.sign(sha256(data), privateKey, { lowS: true }).toCompactRawBytes());
}

export function signText(privateKey: Uint8Array, text: string): string {
  return signBytes(privateKey, utf8ToBytes(text));
}
