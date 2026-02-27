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
