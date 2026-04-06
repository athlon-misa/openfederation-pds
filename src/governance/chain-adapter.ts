/**
 * Chain Adapter Interface and Registry
 *
 * Provides an adapter-based system for verifying governance proofs
 * against actual blockchains, rather than trusting the Oracle alone.
 */

export interface GovernanceProof {
  chainId: string;           // CAIP-2 chain ID (e.g., "eip155:137")
  transactionHash: string;
  blockNumber?: number;
  contractAddress?: string;
  expectedOutcome?: string;
  metadata?: Record<string, unknown>;
}

export interface VerificationResult {
  verified: boolean;
  error?: string;
  blockTimestamp?: number;
  confirmations?: number;
}

export interface ChainAdapter {
  chainId: string;
  name: string;
  verifyProof(proof: GovernanceProof): Promise<VerificationResult>;
}

// ── Adapter Registry ─────────────────────────────────────────────

const adapters = new Map<string, ChainAdapter>();

/**
 * Register a chain adapter for a specific CAIP-2 chain ID.
 * Overwrites any existing adapter for the same chain ID.
 */
export function registerAdapter(adapter: ChainAdapter): void {
  adapters.set(adapter.chainId, adapter);
}

/**
 * Get the adapter registered for a given CAIP-2 chain ID.
 * Returns undefined if no adapter is registered for that chain.
 */
export function getAdapter(chainId: string): ChainAdapter | undefined {
  return adapters.get(chainId);
}

/**
 * List all registered adapters as an array of { chainId, name } entries.
 */
export function listAdapters(): Array<{ chainId: string; name: string }> {
  return Array.from(adapters.values()).map(a => ({
    chainId: a.chainId,
    name: a.name,
  }));
}

/**
 * Clear all registered adapters (useful for testing).
 */
export function clearAdapters(): void {
  adapters.clear();
}
