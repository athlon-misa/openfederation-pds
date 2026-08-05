/**
 * Governance Attestor Capability Contract and Registry
 *
 * Blockchain (and any other external notary) is a capability core governance
 * MAY consult — never an authority core depends on. `GovernanceAttestor` is
 * the single interface core knows about: verifying an externally-submitted
 * proof, and (optionally) anchoring a repo root off-chain for tamper evidence.
 *
 * Core never imports chain/module code directly. A module (e.g. the EVM
 * adapter) registers an attestor implementation here; core only ever talks
 * to the `GovernanceAttestor` shape via the registry below.
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

/**
 * Receipt returned by an attestor's optional `anchor()` call. Minimal shape —
 * consumed by Task 9 when decision resolution triggers anchoring.
 */
export interface AnchorReceipt {
  chainId: string;
  transactionHash?: string;
  anchoredCid: string;
  timestamp?: number;
}

export interface GovernanceAttestor {
  chainId: string;
  name: string;
  verifyProof(proof: GovernanceProof): Promise<VerificationResult>;
  /** Optional: anchor a repo root CID for tamper evidence. Not all attestors support it. */
  anchor?(rootCid: string): Promise<AnchorReceipt>;
}

// ── Attestor Registry ────────────────────────────────────────────

const attestors = new Map<string, GovernanceAttestor>();

/**
 * Register a governance attestor for a specific CAIP-2 chain ID.
 * Overwrites any existing attestor for the same chain ID.
 */
export function registerAttestor(attestor: GovernanceAttestor): void {
  attestors.set(attestor.chainId, attestor);
}

/**
 * Resolve the attestor registered for a given CAIP-2 chain ID.
 * Returns undefined if no attestor is registered for that chain.
 */
export function resolveAttestor(chainId: string): GovernanceAttestor | undefined {
  return attestors.get(chainId);
}

/**
 * List all registered attestors as an array of { chainId, name } entries.
 */
export function listAttestors(): Array<{ chainId: string; name: string }> {
  return Array.from(attestors.values()).map(a => ({
    chainId: a.chainId,
    name: a.name,
  }));
}

/**
 * Clear all registered attestors (useful for testing).
 */
export function clearAttestors(): void {
  attestors.clear();
}
