/**
 * Oracle credential shape.
 *
 * Chain-module surface: it lives here only because the credential lookup
 * (`verifyOracleKey`) still lives in `verification.ts`. Nothing in core auth
 * imports this type — the middleware, guard, and governance plumbing that
 * use it all live in `src/governance/oracle-auth.ts`.
 */
export interface OracleContext {
  credentialId: string;
  communityDid: string;
  name: string;
}
