/**
 * Chain module — public entry point.
 *
 * The architectural rule this module exists to make physical: **modules import
 * core; core never imports modules.** Blockchain is a notary the PDS MAY
 * consult, never an authority it depends on, so every line of chain/oracle
 * code lives under `src/modules/chain/` and core keeps only the neutral
 * contracts it talks through (`src/governance/attestor.ts`,
 * `src/governance/request-authority.ts`) plus the single guarded hook in
 * `enforceGovernance()`.
 *
 * The one unavoidable exception is wiring: something has to compose the
 * application. Exactly two composition-root files may reach into a module, and
 * only through this file:
 *
 *   - `src/server/index.ts`          — installs the module into the express app
 *   - `src/server/handler-registry.ts` — maps the module's XRPC handlers
 *
 * `scripts/check-import-boundaries.ts` enforces both halves of that rule.
 */

export {
  CHAIN_ORACLE_AUTHORITY,
  ORACLE_AUTHENTICATED_NSIDS,
  getOracleContext,
  installOracleAuth as installChainModule,
  oracleAuthMiddleware,
  oracleRequestAuthority,
  requireOracleAuth,
  uninstallOracleAuth as uninstallChainModule,
} from './oracle-auth.js';

export { createEvmAdapter } from './evm-adapter.js';

export type { OracleContext } from './oracle-context.js';

// XRPC handlers owned by this module, consumed by the core handler registry.
export { default as oracleCreateCredential } from './api/net.openfederation.oracle.createCredential.js';
export { default as oracleListCredentials } from './api/net.openfederation.oracle.listCredentials.js';
export { default as oracleRevokeCredential } from './api/net.openfederation.oracle.revokeCredential.js';
export { default as oracleSubmitProof } from './api/net.openfederation.oracle.submitProof.js';
