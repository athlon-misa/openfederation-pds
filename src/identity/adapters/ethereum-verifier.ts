/**
 * Ethereum signature verifier.
 *
 * Uses ethers v6 `verifyMessage` to recover the signer address from an
 * EIP-191 personal_sign message and compare it against the expected wallet.
 */

import { verifyMessage } from 'ethers';

export async function verifyEthereumSignature(
  message: string,
  signature: string,
  expectedAddress: string
): Promise<boolean> {
  try {
    const recovered = verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}
