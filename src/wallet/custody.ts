/**
 * Tier 1 (custodial) wallet key management.
 *
 * Generates fresh wallets for the PDS to hold on the user's behalf, encrypts
 * them at rest using the same AES-256-GCM primitive that already protects
 * community signing keys, and exposes a single-shot signMessage helper that
 * reconstructs the key in memory only for the duration of the signing call.
 *
 * Only used for Tier 1. Tier 2 keys never leave the browser decryptable;
 * Tier 3 keys never touch the PDS at all.
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Wallet } from 'ethers';
import { query } from '../db/client.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';
import type { WalletChain } from './types.js';

export interface GeneratedWallet {
  chain: WalletChain;
  address: string;
  /** Raw private key bytes. Never persisted unencrypted. */
  privateKey: Buffer;
}

/**
 * Generate a fresh keypair for the given chain. Caller must either hand the
 * `privateKey` back to the user (Tier 3) or pass it to `storeCustodialKey`
 * (Tier 1) — never persist it anywhere else.
 */
export function generateWallet(chain: WalletChain): GeneratedWallet {
  if (chain === 'ethereum') {
    const w = Wallet.createRandom();
    // ethers returns the private key prefixed with "0x" — strip + convert.
    const pkHex = w.privateKey.startsWith('0x') ? w.privateKey.slice(2) : w.privateKey;
    return {
      chain,
      address: w.address.toLowerCase(),
      privateKey: Buffer.from(pkHex, 'hex'),
    };
  }

  if (chain === 'solana') {
    const kp = nacl.sign.keyPair();
    // tweetnacl gives us a 64-byte secretKey (32-byte seed || 32-byte publicKey).
    // That's the standard Solana "secret key" format.
    return {
      chain,
      address: bs58.encode(kp.publicKey),
      privateKey: Buffer.from(kp.secretKey),
    };
  }

  throw new Error(`Unsupported chain: ${chain}`);
}

/**
 * Encrypt a Tier 1 private key and insert it into wallet_custody.
 * Throws on conflict — callers should have already checked uniqueness.
 */
export async function storeCustodialKey(
  userDid: string,
  chain: WalletChain,
  walletAddress: string,
  privateKey: Buffer
): Promise<void> {
  const encrypted = await encryptKeyBytes(privateKey);
  await query(
    `INSERT INTO wallet_custody (user_did, chain, wallet_address, private_key_encrypted)
     VALUES ($1, $2, $3, $4)`,
    [userDid, chain, walletAddress, encrypted]
  );
}

/**
 * Load + decrypt a Tier 1 private key. Caller is responsible for wiping the
 * returned Buffer after use (see `signWithCustodialKey` which does this
 * automatically).
 */
export async function loadCustodialKey(
  userDid: string,
  chain: WalletChain,
  walletAddress: string
): Promise<Buffer | null> {
  const result = await query<{ private_key_encrypted: Buffer }>(
    `SELECT private_key_encrypted FROM wallet_custody
     WHERE user_did = $1 AND chain = $2 AND wallet_address = $3`,
    [userDid, chain, walletAddress]
  );
  if (result.rows.length === 0) return null;
  return decryptKeyBytes(result.rows[0].private_key_encrypted);
}

/**
 * Delete the stored Tier 1 key. Used when upgrading to Tier 2/3.
 * Returns true if a row was removed.
 */
export async function deleteCustodialKey(
  userDid: string,
  chain: WalletChain,
  walletAddress: string
): Promise<boolean> {
  const result = await query(
    `DELETE FROM wallet_custody WHERE user_did = $1 AND chain = $2 AND wallet_address = $3`,
    [userDid, chain, walletAddress]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Sign a message using a Tier 1 custodial wallet. Loads, decrypts, signs,
 * then zero-fills the decrypted key buffer before returning.
 *
 * Returns the signature in chain-native encoding:
 *   ethereum → EIP-191 personal_sign hex string (0x-prefixed)
 *   solana   → base58-encoded Ed25519 signature
 */
export async function signWithCustodialKey(opts: {
  userDid: string;
  chain: WalletChain;
  walletAddress: string;
  message: string;
}): Promise<string | null> {
  const privateKey = await loadCustodialKey(opts.userDid, opts.chain, opts.walletAddress);
  if (!privateKey) return null;

  try {
    if (opts.chain === 'ethereum') {
      const wallet = new Wallet('0x' + privateKey.toString('hex'));
      return await wallet.signMessage(opts.message);
    }
    if (opts.chain === 'solana') {
      // tweetnacl's detached sign takes the 64-byte secret key.
      const messageBytes = new TextEncoder().encode(opts.message);
      const sig = nacl.sign.detached(messageBytes, new Uint8Array(privateKey));
      return bs58.encode(sig);
    }
    throw new Error(`Unsupported chain: ${opts.chain}`);
  } finally {
    // Best-effort wipe of the decrypted key material.
    privateKey.fill(0);
  }
}
