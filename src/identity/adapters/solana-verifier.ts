/**
 * Solana signature verifier.
 *
 * Uses tweetnacl to verify an Ed25519 detached signature produced by a
 * Solana wallet (e.g., Phantom `signMessage`). Both the signature and
 * wallet address are base58-encoded.
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';

export async function verifySolanaSignature(
  message: string,
  signatureBase58: string,
  walletAddressBase58: string
): Promise<boolean> {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signatureBase58);
    const publicKeyBytes = bs58.decode(walletAddressBase58);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}
