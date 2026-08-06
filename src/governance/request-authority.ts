/**
 * Governance Request Authority Contract and Registry
 *
 * Core governance sometimes needs to know that an inbound request carries
 * authority delegated by an external module — today the chain module's
 * Oracle credentials (`X-Oracle-Key`), tomorrow anything else that can
 * attest "this request is authorized to act for community X".
 *
 * Core must never import module code, and core must never grow module
 * fields (no `req.oracleAuth` on the shared auth types). So the direction is
 * inverted, mirroring the attestor registry in `attestor.ts`: a module
 * registers a `GovernanceRequestAuthority` here, and core only ever talks to
 * this neutral shape through two narrow accessors:
 *
 *   - `resolveGovernanceContext(req)` — what authority, if any, does this
 *     request carry? Feeds `enforceGovernance()`.
 *   - `runGovernedMutation(...)` — run a repo mutation, giving the module a
 *     chance to wrap it (e.g. durable proof-of-authorization auditing).
 *
 * With no authority registered — a pure-federation PDS — both accessors are
 * inert: no context is ever produced, and mutations run unwrapped.
 */

import type { GovernanceResult } from './enforcement.js';

/**
 * Authority a module attributes to a single inbound request.
 * Deliberately protocol-neutral: no chain, proof, or oracle vocabulary.
 */
export interface GovernanceRequestContext {
  /** Module that attributed this context (e.g. `'chain-oracle'`). */
  source: string;
  /** Community DID this request is authorized to act for. */
  communityDid: string;
  /** Opaque credential identifier, used for audit attribution. */
  credentialId: string;
  /** Human-readable credential name. */
  name: string;
}

/** A repo mutation that a registered authority may wrap. */
export interface GovernedMutation<T> {
  /** The inbound request, opaque to core — the module reads what it needs. */
  request: unknown;
  /** Authority attributed to this request, if any. */
  context: GovernanceRequestContext | null;
  /** Governance outcome for this mutation, or null when not a community repo. */
  governance: GovernanceResult | null;
  communityDid: string;
  collection: string;
  rkey: string;
  action: 'write' | 'delete';
  operation: 'create' | 'put' | 'delete';
  record?: Record<string, unknown>;
  /** The actual repository write. Runs exactly once on success. */
  mutate: () => Promise<T>;
}

export interface GovernanceRequestAuthority {
  /** Stable identifier, matching the `source` it stamps on contexts. */
  name: string;
  /**
   * Extract this authority's context from an inbound request, or null when
   * the request carries none. Must not throw; a throw is treated as null.
   */
  contextFor(request: unknown): GovernanceRequestContext | null;
  /**
   * Wrap a governed mutation. Errors propagate — an authority that cannot
   * record its authorization must be able to block the mutation.
   */
  runMutation<T>(mutation: GovernedMutation<T>): Promise<T>;
}

// ── Authority Registry ───────────────────────────────────────────

let authority: GovernanceRequestAuthority | null = null;

/** Register the governance request authority. Replaces any previous one. */
export function registerGovernanceRequestAuthority(next: GovernanceRequestAuthority): void {
  authority = next;
}

/** Clear the registered authority (module teardown / tests). */
export function clearGovernanceRequestAuthority(): void {
  authority = null;
}

/** The registered authority's name, or null when none is registered. */
export function registeredAuthorityName(): string | null {
  return authority?.name ?? null;
}

/**
 * Resolve the authority context attributed to a request.
 *
 * Fails closed: with no authority registered, or if extraction throws, the
 * request carries no attributed authority. That can only ever make governance
 * stricter, never more permissive.
 */
export function resolveGovernanceContext(request: unknown): GovernanceRequestContext | null {
  if (!authority) return null;
  try {
    return authority.contextFor(request) ?? null;
  } catch (err) {
    console.error(`Governance authority "${authority.name}" failed to extract context:`, err);
    return null;
  }
}

/**
 * Run a repository mutation under the registered authority, if any.
 * With no authority registered the mutation runs directly.
 */
export async function runGovernedMutation<T>(mutation: GovernedMutation<T>): Promise<T> {
  if (!authority) return mutation.mutate();
  return authority.runMutation(mutation);
}
