import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './types.js';
import { config } from '../config.js';
import { query } from '../db/client.js';
import {
  setOAuthVerifier as setAuthVerificationOAuthVerifier,
  verifyRequestAuth,
  verifyPartnerKey,
} from './verification.js';

type OAuthVerifier = {
  authenticateRequest(
    httpMethod: string,
    httpUrl: Readonly<URL>,
    httpHeaders: Record<string, undefined | string | string[]>,
    verifyOptions?: { audience?: [string, ...string[]]; scope?: [string, ...string[]] }
  ): Promise<{ sub: string; [key: string]: unknown }>;
} | null;

export function setOAuthVerifier(verifier: OAuthVerifier): void {
  setAuthVerificationOAuthVerifier(verifier);
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const result = await verifyRequestAuth({
    method: req.method,
    originalUrl: req.originalUrl,
    path: req.path,
    headers: req.headers as Record<string, string | string[] | undefined>,
  });

  if (result.wwwAuthenticateHeader) {
    res.setHeader('WWW-Authenticate', result.wwwAuthenticateHeader);
  }

  req.auth = result.auth;
  req.authError = result.authError;
  req.serviceAuthError = result.serviceAuthError;

  // Verified-email state, loaded fresh per request but only when the policy
  // actually gates on it — under off/advisory (the default) this costs
  // nothing. Fresh rather than a JWT claim, because a claim goes stale the
  // moment the user verifies mid-session and would keep blocking them.
  // Service-auth callers are other servers, not mailbox owners; the concept
  // does not apply to them.
  const policy = config.emailVerification.policy;
  if (req.auth && req.auth.authMethod !== 'service-auth'
    && (policy === 'require-for-write' || policy === 'require-for-login')) {
    try {
      const row = await query<{ verified: boolean }>(
        'SELECT (email_verified_at IS NOT NULL) AS verified FROM users WHERE id = $1',
        [req.auth.userId],
      );
      req.auth.emailVerified = row.rows[0]?.verified ?? false;
    } catch (err) {
      // Fail toward "unverified": under a gating policy, a lookup failure
      // granting access would make a database blip a policy bypass.
      console.error('[email] verified-state lookup failed:', err instanceof Error ? err.message : err);
      req.auth.emailVerified = false;
    }
  }

  const partnerKey = req.headers['x-partner-key'];
  if (typeof partnerKey === 'string' && partnerKey.length > 0) {
    const partnerResult = await verifyPartnerKey({
      rawKey: partnerKey,
      origin: req.headers.origin as string | undefined,
      requiredPermission: '',
    });
    if (partnerResult.ok) {
      req.partnerAuth = partnerResult.partner;
    } else {
      req.partnerAuthError = { status: partnerResult.status, code: partnerResult.code, message: partnerResult.message };
    }
  }

  // NOTE: module credentials (e.g. the chain module's X-Oracle-Key) are
  // deliberately NOT handled here. Modules mount their own middleware on the
  // routes that accept them — see src/modules/chain/oracle-auth.ts.

  next();
}
