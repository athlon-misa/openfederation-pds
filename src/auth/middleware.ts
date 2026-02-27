import type { Response, NextFunction } from 'express';
import type { AuthRequest, UserRole, UserStatus } from './types.js';
import { verifyAccessToken } from './tokens.js';
import { query } from '../db/client.js';
import { config } from '../config.js';

// OAuth verifier (set during server startup if OAuth is enabled)
// Uses the OAuthProvider's authenticateRequest method for DPoP token verification.
let oauthVerifier: {
  authenticateRequest(
    httpMethod: string,
    httpUrl: Readonly<URL>,
    httpHeaders: Record<string, undefined | string | string[]>,
    verifyOptions?: { audience?: [string, ...string[]]; scope?: [string, ...string[]] }
  ): Promise<{ sub: string; [key: string]: unknown }>;
} | null = null;

export function setOAuthVerifier(verifier: typeof oauthVerifier): void {
  oauthVerifier = verifier;
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const dpopHeader = req.headers['dpop'];
  const authHeader = req.headers.authorization;

  // OAuth DPoP path: if DPoP header is present and Authorization uses "DPoP" scheme
  if (dpopHeader && authHeader?.startsWith('DPoP ') && oauthVerifier) {
    try {
      const url = new URL(req.originalUrl, config.pds.serviceUrl);
      const payload = await oauthVerifier.authenticateRequest(
        req.method,
        url,
        req.headers as Record<string, string | string[] | undefined>,
        { scope: ['atproto'] }
      );

      // Look up user by DID (sub) to populate full AuthContext
      const userResult = await query<{ id: string; handle: string; email: string; status: string }>(
        'SELECT id, handle, email, status FROM users WHERE did = $1',
        [payload.sub]
      );

      if (userResult.rows.length === 0) {
        req.authError = 'invalid';
        next();
        return;
      }

      const user = userResult.rows[0];

      // Get roles
      const roleResult = await query<{ role: string }>(
        'SELECT role FROM user_roles WHERE user_id = $1',
        [user.id]
      );

      req.auth = {
        userId: user.id,
        handle: user.handle,
        email: user.email || '',
        did: payload.sub,
        status: user.status as UserStatus,
        roles: roleResult.rows.map(r => r.role) as UserRole[],
        authMethod: 'oauth',
      };
      next();
    } catch (err: unknown) {
      // Set WWW-Authenticate header for proper OAuth error signaling (RFC 6750)
      const oauthErr = err as { wwwAuthenticateHeader?: string };
      if (oauthErr?.wwwAuthenticateHeader) {
        res.setHeader('WWW-Authenticate', oauthErr.wwwAuthenticateHeader);
      }
      req.authError = 'invalid';
      next();
    }
    return;
  }

  // Existing JWT Bearer path
  if (!authHeader) {
    req.authError = 'missing';
    next();
    return;
  }

  if (!authHeader.startsWith('Bearer ')) {
    req.authError = 'invalid';
    next();
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    req.authError = 'missing';
    next();
    return;
  }

  const auth = verifyAccessToken(token);
  if (!auth) {
    req.authError = 'invalid';
    next();
    return;
  }

  req.auth = { ...auth, authMethod: 'local' };
  next();
}
