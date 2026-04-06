/**
 * EVM Chain Adapter
 *
 * Verifies governance proofs against EVM-compatible blockchains
 * using ethers v6 JsonRpcProvider.
 */

import { JsonRpcProvider } from 'ethers';
import type { ChainAdapter, GovernanceProof, VerificationResult } from '../chain-adapter.js';

/**
 * Create an EVM adapter for a specific chain.
 *
 * @param chainId  CAIP-2 chain ID (e.g., "eip155:137")
 * @param name     Human-readable chain name (e.g., "Polygon Mainnet")
 * @param rpcUrl   JSON-RPC endpoint URL
 */
export function createEvmAdapter(chainId: string, name: string, rpcUrl: string): ChainAdapter {
  const provider = new JsonRpcProvider(rpcUrl);

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
          confirmations = currentBlock - receipt.blockNumber;
        } catch {
          // Non-fatal: we still verified the tx, just can't get extras
        }

        return {
          verified: true,
          blockTimestamp,
          confirmations,
        };
      } catch (err: any) {
        // Catch RPC errors gracefully
        const message = err?.message || String(err);
        return {
          verified: false,
          error: `RPC error: ${message.substring(0, 200)}`,
        };
      }
    },
  };
}
