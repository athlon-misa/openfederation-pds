/**
 * Chain-specific HD derivation.
 *
 *   Ethereum: BIP-32 on secp256k1 at m/44'/60'/0'/0/0 → 32-byte private key
 *   Solana:   SLIP-0010 on ed25519 at m/44'/501'/0'/0' → 32-byte seed (expand to 64-byte secretKey)
 */

import { HDKey } from '@scure/bip32';
import { derivePath } from 'ed25519-hd-key';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';

export interface DerivedWallet {
  chain: 'ethereum' | 'solana';
  address: string;
  /**
   * For Ethereum: 32-byte private key bytes (no 0x prefix).
   * For Solana: 64-byte secret key (32-byte seed || 32-byte pubkey) — the
   * native Solana "secret key" format consumed by tweetnacl / @solana/web3.js.
   */
  privateKey: Uint8Array;
  /** BIP-32 / SLIP-0010 path used to derive the key. */
  derivationPath: string;
}

const ETH_PATH = "m/44'/60'/0'/0/0";
const SOL_PATH = "m/44'/501'/0'/0'";

export function deriveEthereumWallet(seed: Uint8Array, path: string = ETH_PATH): DerivedWallet {
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive(path);
  if (!child.privateKey) {
    throw new Error('Failed to derive Ethereum private key');
  }
  const privateKey = child.privateKey;

  // Ethereum address = last 20 bytes of keccak256(uncompressed public key without 0x04 prefix).
  const uncompressed = secp256k1.getPublicKey(privateKey, false); // 65 bytes: 0x04 || X || Y
  const hash = keccak_256(uncompressed.slice(1));
  const addressBytes = hash.slice(-20);
  const address = '0x' + bytesToHex(addressBytes);

  return {
    chain: 'ethereum',
    address,
    privateKey,
    derivationPath: path,
  };
}

export function deriveSolanaWallet(seed: Uint8Array, path: string = SOL_PATH): DerivedWallet {
  // ed25519-hd-key takes a hex-encoded seed.
  const seedHex = bytesToHex(seed);
  const { key } = derivePath(path, seedHex);
  // tweetnacl expands the 32-byte seed into a 64-byte keypair.
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(key));
  const address = bs58.encode(kp.publicKey);

  return {
    chain: 'solana',
    address,
    privateKey: kp.secretKey,
    derivationPath: path,
  };
}

export function deriveWallet(
  chain: 'ethereum' | 'solana',
  seed: Uint8Array,
  path?: string
): DerivedWallet {
  if (chain === 'ethereum') return deriveEthereumWallet(seed, path);
  if (chain === 'solana') return deriveSolanaWallet(seed, path);
  throw new Error(`Unsupported chain: ${chain}`);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
