import type { Response, NextFunction } from 'express';
import type { AuthRequest, UserRole, UserStatus } from './types.js';
import { verifyAccessToken } from './tokens.js';
import { query } from '../db/client.js';
import { config } from '../config.js';
import {
  looksLikeServiceAuthJwt,
  verifyServiceAuthJwt,
  checkServiceAuthRateLimit,
  ServiceAuthError,
} from './service-auth.js';

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

  // Service-auth JWT path: ES256K/ES256-signed tokens issued by the caller's
  // atproto signing key from a peer PDS. Selected purely by header alg so we
  // never try HS256-verifying an asymmetric-signed JWT.
  if (looksLikeServiceAuthJwt(token)) {
    try {
      // If the route is /xrpc/:nsid, scope lxm validation to that NSID.
      const nsidMatch = req.path.match(/^\/xrpc\/([^/]+)/);
      const expectedLxm = nsidMatch ? nsidMatch[1] : undefined;

      const claims = await verifyServiceAuthJwt(token, { expectedLxm });

      if (!checkServiceAuthRateLimit(claims.iss)) {
        req.authError = 'invalid';
        req.serviceAuthError = {
          code: 'RateLimitExceeded',
          message: 'Too many service-auth requests for this DID',
          status: 429,
        };
        next();
        return;
      }

      // If the iss DID corresponds to a local user, pull their profile so
      // roles apply; otherwise treat as an external caller with approved
      // status and no local roles.
      const localUser = await query<{ id: string; handle: string; email: string; status: string }>(
        'SELECT id, handle, email, status FROM users WHERE did = $1',
        [claims.iss]
      );
      if (localUser.rows.length > 0) {
        const u = localUser.rows[0];
        const roleResult = await query<{ role: string }>(
          'SELECT role FROM user_roles WHERE user_id = $1',
          [u.id]
        );
        req.auth = {
          userId: u.id,
          handle: u.handle,
          email: u.email || '',
          did: claims.iss,
          status: u.status as UserStatus,
          roles: roleResult.rows.map(r => r.role) as UserRole[],
          authMethod: 'service-auth',
        };
      } else {
        req.auth = {
          userId: claims.iss,
          handle: claims.iss,
          email: '',
          did: claims.iss,
          status: 'approved',
          roles: [],
          authMethod: 'service-auth',
        };
      }
      next();
    } catch (err) {
      req.authError = 'invalid';
      if (err instanceof ServiceAuthError) {
        req.serviceAuthError = { code: err.code, message: err.message, status: err.status };
      } else {
        req.serviceAuthError = {
          code: 'InvalidToken',
          message: 'Service-auth verification failed',
          status: 401,
        };
      }
      next();
    }
    return;
  }

  const auth = await verifyAccessToken(token);
  if (!auth) {
    req.authError = 'invalid';
    next();
    return;
  }

  req.auth = { ...auth, authMethod: 'local' };
  next();
}
