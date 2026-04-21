/**
 * Client-side message signing for Tier 2 / Tier 3 wallets.
 *
 * Produces the same on-the-wire shapes the PDS's own signers emit (and the
 * existing wallet-link verifiers accept): EIP-191 hex for Ethereum,
 * base58 Ed25519 for Solana.
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';

/**
 * EIP-191 personal_sign produces a signature over
 *   keccak256("\x19Ethereum Signed Message:\n" || len(message) || message)
 * encoded as 65 bytes: r || s || v  where v ∈ {27, 28}.
 */
export function signEthereumMessage(message: string, privateKey: Uint8Array): string {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const digestInput = new Uint8Array(prefix.length + msgBytes.length);
  digestInput.set(prefix, 0);
  digestInput.set(msgBytes, prefix.length);
  const digest = keccak_256(digestInput);

  // prehash:false — we already computed keccak256 of the EIP-191 envelope.
  const sig = secp256k1.sign(digest, privateKey, { prehash: false });
  const r = sig.r.toString(16).padStart(64, '0');
  const s = sig.s.toString(16).padStart(64, '0');
  const recovery = sig.recovery;
  if (recovery !== 0 && recovery !== 1) {
    throw new Error('secp256k1 signature missing recovery bit');
  }
  const v = (27 + recovery).toString(16).padStart(2, '0');
  return '0x' + r + s + v;
}

/** Ed25519 detached signature, base58-encoded. Solana convention. */
export function signSolanaMessage(message: string, secretKey: Uint8Array): string {
  const msgBytes = new TextEncoder().encode(message);
  // Accept either 64-byte Solana secretKey or 32-byte seed.
  const key = secretKey.length === 64 ? secretKey : nacl.sign.keyPair.fromSeed(secretKey).secretKey;
  const sig = nacl.sign.detached(msgBytes, key);
  return bs58.encode(sig);
}

export function signMessage(
  chain: 'ethereum' | 'solana',
  message: string,
  privateKey: Uint8Array
): string {
  if (chain === 'ethereum') return signEthereumMessage(message, privateKey);
  if (chain === 'solana') return signSolanaMessage(message, privateKey);
  throw new Error(`Unsupported chain: ${chain}`);
}
