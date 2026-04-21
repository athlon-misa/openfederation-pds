/**
 * Client-side transaction signing for Tier 2 / Tier 3 wallets.
 *
 * Ethereum: we rely on ethers v6 (declared as an OPTIONAL peerDependency —
 * dApps that already use ethers get it for free; others install it when they
 * opt in). Dynamic import keeps the base SDK bundle small.
 *
 * Solana: the caller passes the serialized transaction-message bytes (what
 * `Transaction.compileMessage().serialize()` emits). We sign with
 * tweetnacl + Ed25519 and return the base58 signature; the caller reassembles
 * the signed transaction (they already own the Transaction object).
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * ethers v6 TransactionRequest shape, kept loose so we can forward it to
 * ethers without hard-coupling the SDK's types to a specific ethers version.
 */
export type EvmTransactionRequest = Record<string, unknown> & {
  chainId: number | bigint | string;
};

/**
 * Sign an Ethereum transaction using ethers v6. Returns the 0x-prefixed
 * signed RLP hex ready to broadcast via `provider.broadcastTransaction(...)`.
 *
 * @param privateKey 32-byte private key bytes
 * @param tx TransactionRequest (must include chainId)
 * @throws if ethers is not installed
 */
export async function signEthereumTransaction(
  privateKey: Uint8Array,
  tx: EvmTransactionRequest
): Promise<string> {
  if (tx.chainId === undefined || tx.chainId === null) {
    throw new Error('tx.chainId is required — refusing to sign a replay-vulnerable transaction');
  }
  let ethers: typeof import('ethers');
  try {
    ethers = await import('ethers');
  } catch {
    throw new Error(
      "ethers is required for EVM transaction signing — install it: `npm install ethers@^6`"
    );
  }
  const pkHex = '0x' + bytesToHex(privateKey);
  const wallet = new ethers.Wallet(pkHex);
  return wallet.signTransaction(tx as unknown as Parameters<typeof wallet.signTransaction>[0]);
}

/**
 * Sign the serialized message of a Solana transaction. Returns the base58
 * Ed25519 detached signature that the caller attaches back onto their
 * `Transaction` (or `VersionedTransaction`) via `.addSignature(publicKey, sig)`.
 */
export function signSolanaTransactionMessage(
  secretKey: Uint8Array,
  messageBytes: Uint8Array
): string {
  const key = secretKey.length === 64 ? secretKey : nacl.sign.keyPair.fromSeed(secretKey).secretKey;
  const sig = nacl.sign.detached(messageBytes, key);
  return bs58.encode(sig);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
