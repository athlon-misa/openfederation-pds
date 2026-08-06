/**
 * Chain module: Oracle request authentication.
 *
 * `X-Oracle-Key` is chain-module surface, not core auth. It is therefore NOT
 * handled by the global auth middleware and NOT carried on the shared
 * `AuthRequest` type — a pure-federation PDS has zero oracle surface in its
 * hot path. Instead this file owns:
 *
 *   1. `oracleAuthMiddleware` — mounted by the module on exactly the routes
 *      that can be Oracle-authorized, and inert unless the chain module is
 *      enabled at request time.
 *   2. A per-request context store (WeakMap, not a request field).
 *   3. The `GovernanceRequestAuthority` implementation registered into core,
 *      which is how Oracle context reaches `enforceGovernance()` and how
 *      Oracle-attributed mutations get their durable audit evidence.
 *
 * Ownership note: this is module code living under `src/governance/` only
 * until the chain module is physically relocated to `src/modules/chain/`.
 */

import type { Express, NextFunction, Request, Response } from 'express';
import { isChainModuleEnabled } from '../config.js';
import type { OracleContext } from '../auth/oracle-guard.js';
import { verifyOracleKey } from '../auth/verification.js';
import {
  executeOracleGovernedMutation,
  prepareOracleMutationAudit,
} from './oracle-mutation-audit.js';
import {
  registerGovernanceRequestAuthority,
  type GovernanceRequestAuthority,
  type GovernanceRequestContext,
  type GovernedMutation,
} from './request-authority.js';

/** `source` stamped on every context this module attributes. */
export const CHAIN_ORACLE_AUTHORITY = 'chain-oracle';

/**
 * Routes that may carry an `X-Oracle-Key`. Everything else in the PDS is
 * unreachable by Oracle authentication, by construction.
 */
export const ORACLE_AUTHENTICATED_NSIDS = [
  'net.openfederation.oracle.submitProof',
  'com.atproto.repo.createRecord',
  'com.atproto.repo.putRecord',
  'com.atproto.repo.deleteRecord',
] as const;

/**
 * Per-request Oracle context. A WeakMap rather than a request property so
 * core's shared auth types stay free of chain fields.
 */
const oracleContexts = new WeakMap<object, OracleContext>();

/** Read the Oracle context attributed to a request, if any. */
export function getOracleContext(request: unknown): OracleContext | null {
  if (!isChainModuleEnabled()) return null;
  if (typeof request !== 'object' || request === null) return null;
  return oracleContexts.get(request) ?? null;
}

/**
 * Validate `X-Oracle-Key` and stash the resulting context for this request.
 * A missing/invalid key is not an error here — route guards decide whether
 * Oracle authentication was required.
 */
export async function oracleAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isChainModuleEnabled()) {
    next();
    return;
  }

  const rawKey = req.headers['x-oracle-key'];
  if (typeof rawKey === 'string' && rawKey.length > 0) {
    try {
      const result = await verifyOracleKey({
        rawKey,
        origin: req.headers.origin as string | undefined,
      });
      if (result.ok) {
        oracleContexts.set(req, result.oracle);
      }
    } catch (err) {
      console.error('Oracle key verification failed:', err);
    }
  }

  next();
}

/**
 * Guard: require a valid Oracle key on this request.
 * Returns the context, or sends 401 and returns null.
 */
export function requireOracleAuth(req: Request, res: Response): OracleContext | null {
  const oracle = getOracleContext(req);
  if (!oracle) {
    res.status(401).json({ error: 'AuthRequired', message: 'Valid X-Oracle-Key header required' });
    return null;
  }
  return oracle;
}

function toOracleContext(context: GovernanceRequestContext | null): OracleContext | null {
  if (!context || context.source !== CHAIN_ORACLE_AUTHORITY) return null;
  return {
    credentialId: context.credentialId,
    communityDid: context.communityDid,
    name: context.name,
  };
}

function governanceProofOf(request: unknown): unknown {
  const body = (request as { body?: unknown } | null)?.body;
  if (typeof body !== 'object' || body === null) return undefined;
  return (body as { governanceProof?: unknown }).governanceProof;
}

/** The chain module's implementation of core's governance authority contract. */
export const oracleRequestAuthority: GovernanceRequestAuthority = {
  name: CHAIN_ORACLE_AUTHORITY,

  contextFor(request: unknown): GovernanceRequestContext | null {
    const oracle = getOracleContext(request);
    if (!oracle) return null;
    return {
      source: CHAIN_ORACLE_AUTHORITY,
      communityDid: oracle.communityDid,
      credentialId: oracle.credentialId,
      name: oracle.name,
    };
  },

  async runMutation<T>(mutation: GovernedMutation<T>): Promise<T> {
    const audit = prepareOracleMutationAudit({
      governance: mutation.governance,
      oracle: toOracleContext(mutation.context),
      governanceProof: governanceProofOf(mutation.request),
    });

    return executeOracleGovernedMutation({
      audit,
      communityDid: mutation.communityDid,
      collection: mutation.collection,
      rkey: mutation.rkey,
      action: mutation.action,
      operation: mutation.operation,
      record: mutation.record,
      mutate: mutation.mutate,
    });
  },
};

/**
 * Install the chain module's Oracle authentication: mount the middleware on
 * the routes that accept an Oracle key, and register the module's authority
 * with core governance.
 *
 * Mounting is unconditional but every entry point re-checks
 * `isChainModuleEnabled()` per request, so the module can be toggled at
 * runtime (tests) and a disabled module authenticates no Oracle anywhere.
 */
export function installOracleAuth(app: Express): void {
  app.post(
    ORACLE_AUTHENTICATED_NSIDS.map((nsid) => `/xrpc/${nsid}`),
    oracleAuthMiddleware,
  );
  registerGovernanceRequestAuthority(oracleRequestAuthority);
}
