/**
 * External user login routes.
 *
 * Handles the OAuth callback from remote ATProto PDSes and exchanges
 * the authorization code for local JWT tokens.
 *
 * Flow (web-interface):
 *   1. Frontend calls resolveExternal XRPC → backend calls client.authorize(handle)
 *   2. User redirected to remote PDS consent page
 *   3. Remote PDS redirects to /oauth/external/callback
 *   4. Backend processes callback → creates/finds local user → issues temp code
 *   5. Backend redirects to frontend /callback?code={temp}
 *   6. Frontend calls POST /oauth/external/complete → gets local JWT tokens
 *
 * Flow (client-side SDK apps):
 *   1. SDK redirects to GET /auth/atproto?handle=...&redirect_uri=...
 *   2. PDS validates redirect_uri, sets cookie, calls client.authorize(handle)
 *   3. User redirected to remote PDS consent page
 *   4. Remote PDS redirects to /oauth/external/callback
 *   5. Backend reads cookie → redirects to client app /callback?code={temp}
 *   6. SDK calls POST /oauth/external/complete → gets local JWT tokens
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { getExternalOAuthClient, getClientMetadata } from './external-client.js';
import { query } from '../db/client.js';
import { signAccessToken, generateRefreshToken, refreshTtlMs } from '../auth/tokens.js';
import type { UserRole, UserStatus } from '../auth/types.js';
import { parseCookies } from '../auth/utils.js';
import { getCachedPartnerOrigins } from '../auth/partner-guard.js';
import { DidResolver } from '@atproto/identity';

// Cookie name for tracking client-app redirects through the OAuth flow
const REDIRECT_COOKIE = 'ofd_auth_redirect';

// Temporary code store for the OAuth callback → frontend handoff.
// Codes expire after 60 seconds — this is an in-memory store since codes
// are consumed immediately by the frontend callback page.
const pendingCodes = new Map<string, { tokens: LocalTokens; expiresAt: number }>();

const MAX_PENDING_CODES = 10_000;

function addPendingCode(code: string, entry: { tokens: LocalTokens; expiresAt: number }): void {
  if (pendingCodes.size >= MAX_PENDING_CODES) {
    const oldest = pendingCodes.keys().next().value;
    if (oldest) pendingCodes.delete(oldest);
  }
  pendingCodes.set(code, entry);
}

interface LocalTokens {
  did: string;
  handle: string;
  email: string;
  accessJwt: string;
  refreshJwt: string;
}

// Clean up expired codes periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingCodes) {
    if (value.expiresAt < now) pendingCodes.delete(key);
  }
}, 30_000).unref();

// Rate limiter for the /auth/atproto initiation endpoint
const atprotoAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RateLimitExceeded', message: 'Too many ATProto auth requests, please try again later' },
});

/**
 * Validate that a redirect_uri's origin is in our allowed list
 * (CORS_ORIGINS + partner origins).
 */
async function isAllowedRedirectOrigin(redirectUri: string): Promise<boolean> {
  let origin: string;
  try {
    const url = new URL(redirectUri);
    origin = url.origin;
  } catch {
    return false;
  }

  // Check static CORS origins
  const staticOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3001')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  if (staticOrigins.includes(origin)) return true;

  // Check partner origins
  const partnerOrigins = await getCachedPartnerOrigins();
  return partnerOrigins.includes(origin);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRedirectConfirmation(res: Response, authUrl: string, handle: string, pdsUrl: string): void {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm External Login — OpenFederation</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           background: #f8f9fa; color: #1a1a2e; display: flex; justify-content: center;
           align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 8px; padding: 2rem; max-width: 480px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; }
    h2 { margin: 0 0 1rem; }
    .pds-url { background: #e9ecef; padding: 0.75rem; border-radius: 4px; font-family: monospace;
               font-size: 0.9rem; word-break: break-all; margin: 1rem 0; }
    .warning { color: #856404; background: #fff3cd; padding: 0.75rem; border-radius: 4px;
               margin: 1rem 0; font-size: 0.9rem; }
    .actions { margin-top: 1.5rem; display: flex; gap: 1rem; justify-content: center; }
    .btn { padding: 0.75rem 1.5rem; border-radius: 4px; border: none; cursor: pointer;
           font-size: 1rem; text-decoration: none; }
    .btn-primary { background: #0f3460; color: #fff; }
    .btn-secondary { background: #e9ecef; color: #1a1a2e; }
  </style>
</head>
<body>
  <div class="card">
    <h2>External Login</h2>
    <p>You are signing in as <strong>${escapeHtml(handle)}</strong></p>
    <p>You will be redirected to your home PDS:</p>
    <div class="pds-url">${escapeHtml(pdsUrl)}</div>
    <div class="warning">
      Verify this is your home PDS before continuing. If you don't recognise this URL, do not proceed.
    </div>
    <div class="actions">
      <a href="${escapeHtml(authUrl)}" class="btn btn-primary">Continue</a>
      <a href="/" class="btn btn-secondary">Cancel</a>
    </div>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
}

export function createExternalOAuthRouter(): Router {
  const router = Router();

  // Serve client metadata document for remote PDSes to fetch
  router.get('/oauth/client-metadata.json', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'max-age=600');
    res.json(getClientMetadata());
  });

  // ── New: PDS-hosted ATProto OAuth initiation for client-side apps ──
  // SDK redirects here; no CORS needed (full page navigation).
  router.get('/auth/atproto', atprotoAuthLimiter, async (req: Request, res: Response) => {
    const handle = req.query.handle as string | undefined;
    const redirectUri = req.query.redirect_uri as string | undefined;
    const state = req.query.state as string | undefined;

    if (!handle || typeof handle !== 'string') {
      return res.status(400).json({ error: 'InvalidRequest', message: 'handle query parameter is required' });
    }
    if (!redirectUri || typeof redirectUri !== 'string') {
      return res.status(400).json({ error: 'InvalidRequest', message: 'redirect_uri query parameter is required' });
    }

    // Validate redirect_uri origin against allowlist (open redirect prevention)
    const allowed = await isAllowedRedirectOrigin(redirectUri);
    if (!allowed) {
      return res.status(400).json({ error: 'InvalidRequest', message: 'redirect_uri origin is not allowed' });
    }

    const client = getExternalOAuthClient();
    if (!client) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'External OAuth login is not available' });
    }

    try {
      // Set cookie so we know where to redirect after the OAuth callback
      const cookieValue = JSON.stringify({ redirectUri, state: state || '' });
      const isProduction = process.env.NODE_ENV === 'production';
      res.setHeader('Set-Cookie', [
        `${REDIRECT_COOKIE}=${encodeURIComponent(cookieValue)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${isProduction ? '; Secure' : ''}`,
      ]);

      // Initiate the OAuth flow with the remote PDS
      const authUrl = await client.authorize(handle.trim(), {
        signal: AbortSignal.timeout(30_000),
      });

      // Resolve the base PDS URL (origin only) to show the user before redirecting
      let pdsServiceUrl: string;
      try {
        pdsServiceUrl = new URL(authUrl.toString()).origin;
      } catch {
        pdsServiceUrl = authUrl.toString();
      }

      // Show a confirmation page before redirecting to the external PDS
      renderRedirectConfirmation(res, authUrl.toString(), handle.trim(), pdsServiceUrl);
    } catch (err) {
      console.error('ATProto auth initiation error:', err);
      // Redirect back to client app with error
      try {
        const errorUrl = new URL(redirectUri);
        errorUrl.searchParams.set('error', 'auth_initiation_failed');
        if (state) errorUrl.searchParams.set('state', state);
        res.redirect(errorUrl.toString());
      } catch {
        res.status(500).json({ error: 'InternalServerError', message: 'Failed to initiate ATProto login' });
      }
    }
  });

  // OAuth callback from remote PDS
  router.get('/oauth/external/callback', async (req: Request, res: Response) => {
    const client = getExternalOAuthClient();
    if (!client) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'OAuth client not initialized' });
    }

    // Check for the redirect cookie (client-side SDK flow)
    const cookies = parseCookies(req.headers.cookie);
    const redirectCookie = cookies[REDIRECT_COOKIE];
    let clientRedirect: { redirectUri: string; state: string } | null = null;

    if (redirectCookie) {
      try {
        clientRedirect = JSON.parse(redirectCookie);
      } catch {
        // Invalid cookie — fall through to web-interface flow
      }
      // Clear the cookie regardless
      res.setHeader('Set-Cookie', [
        `${REDIRECT_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      ]);
    }

    try {
      const params = new URLSearchParams(req.query as Record<string, string>);
      const { session } = await client.callback(params);
      const did = session.did;

      // Create or find local user for this external DID
      const localTokens = await ensureExternalUser(did, session);

      // Generate a temporary code for the frontend to exchange
      const tempCode = crypto.randomBytes(32).toString('hex');
      addPendingCode(tempCode, {
        tokens: localTokens,
        expiresAt: Date.now() + 60_000, // 60 seconds
      });

      if (clientRedirect?.redirectUri) {
        // SDK flow: redirect to the client app's callback URL
        const redirectUrl = new URL(clientRedirect.redirectUri);
        redirectUrl.searchParams.set('code', tempCode);
        if (clientRedirect.state) {
          redirectUrl.searchParams.set('state', clientRedirect.state);
        }
        res.redirect(redirectUrl.toString());
      } else {
        // Web-interface flow: redirect to the web UI callback page
        const frontendUrl = (process.env.CORS_ORIGINS || 'http://localhost:3001').split(',')[0].trim();
        const redirectUrl = new URL('/callback', frontendUrl);
        redirectUrl.searchParams.set('code', tempCode);
        res.redirect(redirectUrl.toString());
      }
    } catch (err) {
      console.error('External OAuth callback error:', err);

      if (clientRedirect?.redirectUri) {
        // SDK flow: redirect to client app with error
        try {
          const errorUrl = new URL(clientRedirect.redirectUri);
          errorUrl.searchParams.set('error', 'oauth_callback_failed');
          if (clientRedirect.state) {
            errorUrl.searchParams.set('state', clientRedirect.state);
          }
          res.redirect(errorUrl.toString());
        } catch {
          res.status(500).json({ error: 'InternalServerError', message: 'OAuth callback failed' });
        }
      } else {
        // Web-interface flow: redirect to web UI with error
        const frontendUrl = (process.env.CORS_ORIGINS || 'http://localhost:3001').split(',')[0].trim();
        const errorUrl = new URL('/callback', frontendUrl);
        errorUrl.searchParams.set('error', 'oauth_callback_failed');
        res.redirect(errorUrl.toString());
      }
    }
  });

  // Exchange temporary code for local JWT tokens
  router.post('/oauth/external/complete', async (req: Request, res: Response) => {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'InvalidRequest', message: 'code is required' });
    }

    const pending = pendingCodes.get(code);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingCodes.delete(code);
      return res.status(400).json({ error: 'InvalidCode', message: 'Code is invalid or expired' });
    }

    pendingCodes.delete(code);
    res.json({
      ...pending.tokens,
      active: true,
    });
  });

  return router;
}

/**
 * Ensure an external user exists in the local database.
 * If the DID already exists, update last activity.
 * If not, create a new user row with auth_type='external'.
 */
async function ensureExternalUser(
  did: string,
  session: { did: string; serverMetadata?: { issuer?: string } }
): Promise<LocalTokens> {
  // Check if user already exists
  const existing = await query<{
    id: string;
    handle: string;
    email: string;
    status: string;
  }>(
    'SELECT id, handle, email, status FROM users WHERE did = $1',
    [did]
  );

  let userId: string;
  let handle: string;
  let email: string;
  let status: UserStatus;

  if (existing.rows.length > 0) {
    const user = existing.rows[0];
    userId = user.id;
    handle = user.handle;
    email = user.email || '';
    status = user.status as UserStatus;

    // Update handle from DID document if it was a DID-derived placeholder
    if (handle.startsWith('plc-') || handle.startsWith('web-')) {
      const resolvedHandle = await resolveHandleFromDid(did);
      if (resolvedHandle && resolvedHandle !== handle) {
        handle = resolvedHandle;
        await query('UPDATE users SET handle = $1 WHERE id = $2', [handle, userId]);
      }
    }
  } else {
    // Create new external user — resolve handle from DID document
    userId = crypto.randomUUID();
    handle = await resolveHandleFromDid(did) || did.replace(/^did:/, '').replace(/:/g, '-');
    email = '';
    status = 'approved'; // External users are auto-approved at PDS level

    const pdsUrl = session.serverMetadata?.issuer || null;

    await query(
      `INSERT INTO users (id, handle, email, password_hash, status, did, auth_type, pds_url)
       VALUES ($1, $2, $3, NULL, $4, $5, 'external', $6)`,
      [userId, handle, email, status, did, pdsUrl]
    );

    await query(
      'INSERT INTO user_roles (user_id, role) VALUES ($1, $2)',
      [userId, 'user']
    );

    console.log(`External user created: ${did} (handle: ${handle})`);
  }

  // Get roles
  const rolesResult = await query<{ role: string }>(
    'SELECT role FROM user_roles WHERE user_id = $1',
    [userId]
  );
  const roles = rolesResult.rows.map(r => r.role) as UserRole[];

  // Issue local JWT tokens
  const accessJwt = signAccessToken({
    userId,
    handle,
    email,
    did,
    status,
    roles,
  });

  const { token: refreshJwt, hash } = generateRefreshToken();
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + refreshTtlMs());

  await query(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, userId, hash, expiresAt.toISOString()]
  );

  return { did, handle, email, accessJwt, refreshJwt };
}

/**
 * Resolve the handle (alsoKnownAs) from a DID document.
 * Returns the handle string (without at:// prefix) or null if resolution fails.
 */
async function resolveHandleFromDid(did: string): Promise<string | null> {
  try {
    // Use default PLC directory (https://plc.directory) for resolving external DIDs
    // rather than our own PLC directory which only has local DIDs
    const resolver = new DidResolver({});
    const doc = await resolver.resolve(did);
    if (doc?.alsoKnownAs) {
      for (const aka of doc.alsoKnownAs) {
        if (aka.startsWith('at://')) {
          return aka.slice('at://'.length);
        }
      }
    }
    return null;
  } catch (err) {
    console.warn(`Failed to resolve handle for ${did}:`, err);
    return null;
  }
}
