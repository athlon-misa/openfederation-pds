/**
 * OAuth route integration for Express.
 *
 * Mounts the @atproto/oauth-provider middleware which auto-registers:
 *   - GET  /.well-known/oauth-authorization-server
 *   - POST /oauth/par (Pushed Authorization Request)
 *   - GET  /oauth/authorize (consent UI)
 *   - POST /oauth/token
 *   - GET  /oauth/jwks
 *   - POST /oauth/revoke
 *
 * Also adds /.well-known/oauth-protected-resource (required by ATProto).
 */

import { Router, Request, Response } from 'express';
import { oauthMiddleware, OAuthProvider } from '@atproto/oauth-provider';
import { config } from '../config.js';
import { authLimiter, registrationLimiter } from '../server/rate-limits.js';

export function createOAuthRouter(provider: OAuthProvider): Router {
  const router = Router();

  // OAuth Protected Resource Metadata (ATProto requirement)
  router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'max-age=600');
    res.json({
      resource: config.pds.serviceUrl,
      authorization_servers: [config.pds.serviceUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['atproto'],
    });
  });

  // Mount all OAuth provider routes
  const middleware = oauthMiddleware(provider, {
    onError: (_req, _res, err, message) => {
      console.error(`OAuth error (${message}):`, err);
    },
  });

  // The provider serves its own sign-in and sign-up forms and has no rate
  // limiting of its own. Without this they sit behind the global limit only,
  // which allows far more password guesses per minute than createSession does.
  router.use((req: Request, res: Response, next) => {
    const which = oauthCredentialLimiterFor(req.method, req.path);
    if (which === 'auth') return authLimiter(req, res, next);
    if (which === 'registration') return registrationLimiter(req, res, next);
    next();
  });

  // The oauthMiddleware returns a handler(req, res) function.
  // Express expects (req, res, next), so we wrap it.
  router.use((req: Request, res: Response, next) => {
    // Let the OAuth middleware handle it; if it doesn't match any route, it passes through
    Promise.resolve(middleware(req, res)).then(() => {
      if (!res.headersSent) {
        next();
      }
    }).catch(next);
  });

  return router;
}

/**
 * Which stricter limiter, if any, a request to the OAuth provider gets.
 * Matched on the last path segment so it holds whatever prefix the provider
 * mounts its API under.
 */
export function oauthCredentialLimiterFor(method: string, path: string): 'auth' | 'registration' | null {
  if (method !== 'POST') return null;
  const last = path.replace(/\/+$/, '').split('/').pop() ?? '';
  if (last === 'sign-in' || last === 'reset-password-request' || last === 'reset-password-confirm') return 'auth';
  if (last === 'sign-up') return 'registration';
  return null;
}
