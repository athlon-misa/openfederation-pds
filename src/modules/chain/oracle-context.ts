/**
 * Oracle credential shape.
 *
 * Chain-module surface, owned by the chain module. Core auth knows nothing
 * about it — the middleware, guard, credential lookup, and governance plumbing
 * that use it all live alongside this file under `src/modules/chain/`.
 */
export interface OracleContext {
  credentialId: string;
  communityDid: string;
  name: string;
}
