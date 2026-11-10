/**
 * EVM Chain Adapter
 *
 * Verifies governance proofs against EVM-compatible blockchains
 * using ethers v6 JsonRpcProvider.
 */

import { JsonRpcProvider } from 'ethers';
import type { GovernanceAttestor, GovernanceProof, VerificationResult } from '../../governance/attestor.js';

const MIN_CONFIRMATIONS = 6;

/**
 * Create an EVM attestor for a specific chain.
 *
 * @param chainId  CAIP-2 chain ID (e.g., "eip155:137")
 * @param name     Human-readable chain name (e.g., "Polygon Mainnet")
 * @param rpcUrl   JSON-RPC endpoint URL
 */
/**
 * An RPC error, made safe to store and return. Provider errors embed the
 * request URL, and the URL is where the API key lives; this text goes into
 * API responses, `proof_verifications` and the audit log. So the provider's
 * short error code is used when there is one, and anything URL-shaped, plus
 * the configured endpoint itself, is removed from whatever remains.
 */
function describeRpcError(err: unknown, rpcUrl: string): string {
  const e = err as { code?: unknown; shortMessage?: unknown; message?: unknown } | null;
  const raw = typeof e?.shortMessage === 'string'
    ? e.shortMessage
    : typeof e?.message === 'string' ? e.message : String(err);
  let text = raw.split(rpcUrl).join('[rpc]').replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)}\]]+/gi, '[url]');
  try {
    const host = new URL(rpcUrl).host;
    if (host) text = text.split(host).join('[rpc]');
  } catch { /* not a URL; nothing more to strip */ }
  const code = typeof e?.code === 'string' ? `${e.code}: ` : '';
  return `${code}${text}`.substring(0, 200);
}

/** The provider calls the adapter makes; injectable so the adapter can be tested without a chain. */
type EvmProvider = Pick<JsonRpcProvider, 'getTransactionReceipt' | 'getBlock' | 'getBlockNumber'>;

export function createEvmAdapter(
  chainId: string,
  name: string,
  rpcUrl: string,
  providerOverride?: EvmProvider,
): GovernanceAttestor {
  const provider: EvmProvider = providerOverride ?? new JsonRpcProvider(rpcUrl);

  return {
    chainId,
    name,

    async verifyProof(proof: GovernanceProof): Promise<VerificationResult> {
      try {
        // 1. Fetch the transaction receipt
        const receipt = await provider.getTransactionReceipt(proof.transactionHash);

        if (!receipt) {
          return { verified: false, error: 'Transaction not found on chain' };
        }

        // 2. Check transaction status (status === 1 means success)
        if (receipt.status !== 1) {
          return { verified: false, error: 'Transaction reverted (status !== 1)' };
        }

        // 3. Validate contract address if provided
        if (proof.contractAddress) {
          const expectedAddr = proof.contractAddress.toLowerCase();
          const actualAddr = receipt.to?.toLowerCase();
          if (actualAddr !== expectedAddr) {
            return {
              verified: false,
              error: `Contract address mismatch: expected ${proof.contractAddress}, got ${receipt.to}`,
            };
          }
        }

        // 4. Validate block number if provided
        if (proof.blockNumber !== undefined && receipt.blockNumber !== proof.blockNumber) {
          return {
            verified: false,
            error: `Block number mismatch: expected ${proof.blockNumber}, got ${receipt.blockNumber}`,
          };
        }

        // 5. Get block timestamp and confirmation count
        let blockTimestamp: number | undefined;
        let confirmations: number | undefined;

        try {
          const block = await provider.getBlock(receipt.blockNumber);
          if (block) {
            blockTimestamp = block.timestamp;
          }
          const currentBlock = await provider.getBlockNumber();
          confirmations = currentBlock - receipt.blockNumber + 1;
          if (confirmations < MIN_CONFIRMATIONS) {
            return {
              verified: false,
              error: `Transaction has only ${confirmations} confirmation(s); ${MIN_CONFIRMATIONS} required`,
              blockTimestamp,
              confirmations,
            };
          }
        } catch (err) {
          // The confirmation depth is part of the verification, not an extra:
          // a transaction in a block that may still be reorganised away is
          // exactly what the minimum is there to exclude. If the depth could
          // not be read, the proof is not verified. The caller can retry.
          return {
            verified: false,
            error: `Could not confirm the transaction's depth: ${describeRpcError(err, rpcUrl)}`,
            blockTimestamp,
          };
        }

        return {
          verified: true,
          blockTimestamp,
          confirmations,
        };
      } catch (err: any) {
        // Catch RPC errors gracefully
        return {
          verified: false,
          error: `RPC error: ${describeRpcError(err, rpcUrl)}`,
        };
      }
    },
  };
}
