import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './types.js';
import {
  setOAuthVerifier as setAuthVerificationOAuthVerifier,
  verifyRequestAuth,
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
  next();
}
