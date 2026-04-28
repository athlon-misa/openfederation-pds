import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './types.js';
import {
  setOAuthVerifier as setAuthVerificationOAuthVerifier,
  verifyRequestAuth,
  verifyPartnerKey,
  verifyOracleKey,
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

  const oracleKey = req.headers['x-oracle-key'];
  if (typeof oracleKey === 'string' && oracleKey.length > 0) {
    const oracleResult = await verifyOracleKey({
      rawKey: oracleKey,
      origin: req.headers.origin as string | undefined,
    });
    if (oracleResult.ok) {
      req.oracleAuth = oracleResult.oracle;
    }
  }

  next();
}
