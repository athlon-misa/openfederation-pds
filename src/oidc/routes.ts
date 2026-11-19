/**
 * OpenID Connect provider (ADR-005).
 *
 *   GET  /oidc/.well-known/openid-configuration   discovery
 *   GET  /oidc/jwks                                 signing key
 *   GET  /oidc/authorize                            an app starts a sign-in
 *   GET  /oidc/authorize/signin                     the handle form
 *   POST /oidc/authorize/identify                   handle → password form, or the person's own server
 *   POST /oidc/authorize/password                   accounts of this server
 *   GET  /oidc/authorize/continue                   signed in → code → back to the app
 *   POST /oidc/token                                code → ID token + access token
 *   GET|POST /oidc/userinfo                         claims
 *
 * Accounts of other servers sign in at their own server through the AT
 * Protocol OAuth client this PDS already has; its callback
 * (/oauth/external/callback) hands them back with `completeAtprotoSignIn`.
 */
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { runtimeSettings } from '../settings/runtime-settings.js';
import { parseCookies, fullHandle } from '../auth/utils.js';
import { checkPasswordWithLockout } from '../auth/password-check.js';
import { handleForHost } from '../server/tls-check.js';
import { getExternalOAuthClient, SIGNIN_SCOPE, SIGNIN_SCOPE_WITH_EMAIL } from '../oauth/external-client.js';
import { claimsFor, parseScopes, SUPPORTED_SCOPES, type OidcScope, type SignedInPerson } from './claims.js';
import { getClient, authenticateClient, type OidcClient } from './clients.js';
import { getOidcSigningKey } from './keys.js';
import {
  createRequest, getOpenRequest, getRequestById, recordSignIn, issueCode, redeemCode,
  REQUEST_TTL_SECONDS, type OidcRequest,
} from './requests.js';
import { localPerson, remotePerson, isCommunityMember, communityName } from './person.js';
import { signIdToken, signAccessToken, verifyAccessToken, ACCESS_TOKEN_TTL_SECONDS } from './tokens.js';
import { signInPage, passwordPage, errorPage, signedOutPage } from './pages.js';
import { compactVerify } from 'jose';

/** The provider's issuer: `{PDS_SERVICE_URL}/oidc`. */
export function oidcIssuer(): string {
  return `${config.pds.serviceUrl.replace(/\/+$/, '')}/oidc`;
}

/** State prefix that marks an AT Protocol sign-in as part of an OIDC request. */
export const OIDC_STATE_PREFIX = 'oidc:';

const COOKIE_PREFIX = 'ofd_oidc_';

function serverName(): string {
  return config.pds.hostname || new URL(config.pds.serviceUrl).host;
}

function hostOf(uri: string): string {
  try { return new URL(uri).host; } catch { return uri; }
}

function browserToken(req: Request, requestId: string): string | undefined {
  return parseCookies(req.headers.cookie)[`${COOKIE_PREFIX}${requestId}`];
}

function setBrowserCookie(res: Response, requestId: string, token: string): void {
  const secure = config.env.isProduction ? '; Secure' : '';
  res.append('Set-Cookie',
    `${COOKIE_PREFIX}${requestId}=${token}; HttpOnly; SameSite=Lax; Path=/oidc; Max-Age=${REQUEST_TTL_SECONDS}${secure}`);
}

function clearBrowserCookie(res: Response, requestId: string): void {
  res.append('Set-Cookie', `${COOKIE_PREFIX}${requestId}=; HttpOnly; SameSite=Lax; Path=/oidc; Max-Age=0`);
}

/** Send an OAuth error back to the app (only once its redirect URI is known to be registered). */
function redirectError(res: Response, redirectUri: string, error: string, description: string, state: string | null): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', oidcIssuer());
  res.redirect(303, url.toString());
}

function grantedScopes(request: OidcRequest, client: OidcClient): OidcScope[] {
  return parseScopes(request.scope).filter((s) => client.scopes.includes(s));
}

// Sign-in pages and the token endpoint: DISCOVERY_RATE_LIMIT a minute per IP
// (a sign-in is about four page loads). Password attempts: AUTH_RATE_LIMIT
// per 15 minutes, like createSession, on top of the per-account lockout.
const pageLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimits.discoveryPerMin,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => errorPage(res, 429, 'Too many attempts', 'Wait a minute and try again.'),
});

const passwordLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.rateLimits.authPer15Min,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => errorPage(res, 429, 'Too many attempts', 'Wait a few minutes and try again.'),
});

const tokenLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimits.discoveryPerMin,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => { res.status(429).json({ error: 'slow_down', error_description: 'Too many requests' }); },
});

interface LocalAccount {
  id: string;
  did: string;
  handle: string;
  email: string | null;
  password_hash: string | null;
  status: string;
  auth_type: string | null;
  email_verified: boolean;
}

/**
 * The account of this server a handle names, when it can sign in with a
 * password here. Accounts from other servers (`external`) and pen names are
 * not: the first sign in at their own server, the second cannot sign in to
 * apps in this version (ADR-005, decision 2).
 */
async function localAccountFor(rawHandle: string): Promise<LocalAccount | null> {
  const handle = rawHandle.trim().toLowerCase().replace(/^@/, '');
  const bare = handleForHost(handle) ?? (handle.includes('.') ? null : handle);
  if (!bare) return null;
  const r = await query<LocalAccount>(
    `SELECT id, did, handle, email, password_hash, status, auth_type, (email_verified_at IS NOT NULL) AS email_verified
     FROM users WHERE handle = $1`,
    [bare],
  );
  const user = r.rows[0];
  if (!user || !user.did || !user.password_hash) return null;
  if (user.auth_type === 'external' || user.auth_type === 'pseudonym') return null;
  return user;
}

async function renderSignIn(res: Response, request: OidcRequest, client: OidcClient, extra: { handle?: string; error?: string } = {}): Promise<void> {
  signInPage(res, {
    requestId: request.id,
    appName: client.name,
    appHost: hostOf(request.redirectUri),
    serverName: serverName(),
    scopes: grantedScopes(request, client),
    communityName: client.communityDid ? await communityName(client.communityDid) : null,
    ...extra,
  });
}

/**
 * Called by the AT Protocol OAuth callback when the sign-in it finished was
 * started here. Records who signed in and returns where to send the browser
 * (continue re-checks the browser cookie), or null when the request is gone.
 */
export async function completeAtprotoSignIn(
  state: string,
  did: string,
  sharedEmail: { email: string; emailVerified: boolean } | null = null,
): Promise<string | null> {
  const requestId = state.slice(OIDC_STATE_PREFIX.length);
  const request = await getRequestById(requestId);
  if (!request) return null;
  // Only an app that asked for email gets the shared address.
  const email = parseScopes(request.scope).includes('email') ? sharedEmail : null;
  if (!(await recordSignIn(request.id, did, null, 'atproto', email))) return null;
  return `/oidc/authorize/continue?request=${encodeURIComponent(request.id)}`;
}

export function createOidcRouter(): Router {
  const router = Router();

  // Off: every route falls through to the 404 handler (ADR-005, decision 10).
  router.use('/oidc', (_req: Request, _res: Response, next: NextFunction) => {
    if (!runtimeSettings().oidcProviderEnabled) {
      next('router');
      return;
    }
    next();
  });

  const form = express.urlencoded({ extended: false, limit: '16kb' });

  router.get('/oidc/.well-known/openid-configuration', (_req: Request, res: Response) => {
    const issuer = oidcIssuer();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      end_session_endpoint: `${issuer}/end_session`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...SUPPORTED_SCOPES],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'did', 'did_slug', 'handle', 'preferred_username', 'name', 'email', 'email_verified'],
      claims_parameter_supported: false,
      request_parameter_supported: false,
      request_uri_parameter_supported: false,
      authorization_response_iss_parameter_supported: true,
    });
  });

  /**
   * RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0). There is no
   * sign-in session here to end (ADR-005, decision 9), so this only sends the
   * person back to the app: to `post_logout_redirect_uri` when it is on the
   * same origin as one of the app's registered redirect URIs, else to a
   * "signed out" page. The app is known from `client_id` or from the
   * audience of `id_token_hint`, whose signature must be this provider's
   * (its expiry does not matter: it is a hint, not a credential). Mastodon
   * with OMNIAUTH_ONLY sends every sign-out here and answered 404 without it.
   */
  const endSession = async (req: Request, res: Response) => {
    const params = { ...(req.query as Record<string, unknown>), ...(req.body ?? {}) } as Record<string, unknown>;
    const str = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : undefined);
    try {
      let clientId = str('client_id');
      const hint = str('id_token_hint');
      if (!clientId && hint) {
        try {
          const key = await getOidcSigningKey();
          const { payload } = await compactVerify(hint, key.publicKey);
          const claims = JSON.parse(new TextDecoder().decode(payload)) as { iss?: string; aud?: string | string[] };
          if (claims.iss === oidcIssuer()) clientId = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
        } catch {
          // Not one of ours: treated as no hint.
        }
      }
      const client = clientId ? await getClient(clientId) : null;
      const origins = new Set((client?.redirectUris ?? []).map((u) => { try { return new URL(u).origin; } catch { return ''; } }).filter(Boolean));
      const target = str('post_logout_redirect_uri');
      if (client && target) {
        try {
          const url = new URL(target);
          if (origins.has(url.origin) && (url.protocol === 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
            const state = str('state');
            if (state) url.searchParams.set('state', state.slice(0, 1024));
            res.redirect(303, url.toString());
            return;
          }
        } catch {
          // Not a URL: fall through to the page.
        }
      }
      signedOutPage(res, {
        appName: client?.name ?? null,
        appOrigin: client ? (client.appUrl ?? ([...origins][0] ?? null)) : null,
        serverName: serverName(),
      });
    } catch (err) {
      console.error('OIDC end_session error:', err);
      errorPage(res, 500, 'Something went wrong', 'You can close this page.');
    }
  };
  router.get('/oidc/end_session', pageLimiter, endSession);
  router.post('/oidc/end_session', pageLimiter, form, endSession);

  router.get('/oidc/jwks', async (_req: Request, res: Response) => {
    try {
      const key = await getOidcSigningKey();
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ keys: [key.publicJwk] });
    } catch (err) {
      console.error('OIDC jwks error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  router.get('/oidc/authorize', pageLimiter, async (req: Request, res: Response) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const client = typeof q.client_id === 'string' ? await getClient(q.client_id) : null;
      if (!client) {
        errorPage(res, 400, 'Unknown app', 'This app is not registered with this server. Ask its operator to check the client ID.');
        return;
      }
      // Never redirect anywhere before the redirect URI is known to be registered.
      const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : '';
      if (!client.redirectUris.includes(redirectUri)) {
        errorPage(res, 400, 'Wrong return address', 'The app asked to return to an address it has not registered. Ask its operator to check the redirect URI.');
        return;
      }
      const state = typeof q.state === 'string' ? q.state.slice(0, 1024) : null;
      if (q.response_type !== 'code') {
        redirectError(res, redirectUri, 'unsupported_response_type', 'Only response_type=code is supported', state);
        return;
      }
      const scopes = parseScopes(q.scope);
      if (!scopes.includes('openid')) {
        redirectError(res, redirectUri, 'invalid_scope', 'The openid scope is required', state);
        return;
      }
      const challenge = typeof q.code_challenge === 'string' ? q.code_challenge : null;
      if (challenge && (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))) {
        redirectError(res, redirectUri, 'invalid_request', 'Only code_challenge_method=S256 is supported', state);
        return;
      }
      if (q.prompt === 'none') {
        // No remembered session here (ADR-005, decision 9).
        redirectError(res, redirectUri, 'login_required', 'Signing in needs the person', state);
        return;
      }
      const { id, browserToken: token } = await createRequest({
        clientId: client.clientId,
        redirectUri,
        scope: scopes.filter((s) => client.scopes.includes(s)).join(' '),
        state,
        nonce: typeof q.nonce === 'string' ? q.nonce.slice(0, 512) : null,
        codeChallenge: challenge,
      });
      setBrowserCookie(res, id, token);
      const hint = typeof q.login_hint === 'string' ? `&login_hint=${encodeURIComponent(q.login_hint.slice(0, 253))}` : '';
      res.redirect(303, `/oidc/authorize/signin?request=${encodeURIComponent(id)}${hint}`);
    } catch (err) {
      console.error('OIDC authorize error:', err);
      errorPage(res, 500, 'Something went wrong', 'Try again from the app.');
    }
  });

  router.get('/oidc/authorize/signin', pageLimiter, async (req: Request, res: Response) => {
    const id = String(req.query.request ?? '');
    const request = await getOpenRequest(id, browserToken(req, id));
    const client = request ? await getClient(request.clientId) : null;
    if (!request || !client) {
      errorPage(res, 400, 'This sign-in has expired', 'Go back to the app and start again.');
      return;
    }
    const hint = typeof req.query.login_hint === 'string' ? req.query.login_hint : undefined;
    await renderSignIn(res, request, client, { handle: hint });
  });

  router.post('/oidc/authorize/identify', pageLimiter, form, async (req: Request, res: Response) => {
    const id = String(req.body?.request ?? '');
    const request = await getOpenRequest(id, browserToken(req, id));
    const client = request ? await getClient(request.clientId) : null;
    if (!request || !client) {
      errorPage(res, 400, 'This sign-in has expired', 'Go back to the app and start again.');
      return;
    }
    const handle = String(req.body?.handle ?? '').trim().replace(/^@/, '').toLowerCase().slice(0, 253);
    if (!handle) {
      await renderSignIn(res, request, client, { error: 'Enter your handle.' });
      return;
    }
    try {
      const local = await localAccountFor(handle);
      if (local) {
        passwordPage(res, { requestId: request.id, appName: client.name, handle: fullHandle(local.handle) });
        return;
      }
      const atproto = getExternalOAuthClient();
      if (!atproto) {
        await renderSignIn(res, request, client, { handle, error: 'Signing in with an account from another server is not available here.' });
        return;
      }
      const url = await atproto.authorize(handle, {
        // Ask the person's own server for their email only when the app asked for it (#461).
        scope: parseScopes(request.scope).includes('email') ? SIGNIN_SCOPE_WITH_EMAIL : SIGNIN_SCOPE,
        state: `${OIDC_STATE_PREFIX}${request.id}`,
        signal: AbortSignal.timeout(30_000),
      });
      res.redirect(303, url.toString());
    } catch (err) {
      console.warn('OIDC identify failed:', err instanceof Error ? err.message : err);
      await renderSignIn(res, request, client, {
        handle,
        error: 'That handle could not be found. Enter your full handle, for example alice.bsky.social.',
      });
    }
  });

  router.post('/oidc/authorize/password', passwordLimiter, form, async (req: Request, res: Response) => {
    const id = String(req.body?.request ?? '');
    const request = await getOpenRequest(id, browserToken(req, id));
    const client = request ? await getClient(request.clientId) : null;
    if (!request || !client) {
      errorPage(res, 400, 'This sign-in has expired', 'Go back to the app and start again.');
      return;
    }
    const shownHandle = String(req.body?.handle ?? '').slice(0, 253);
    const password = String(req.body?.password ?? '');
    const retry = (error: string, status = 401) => passwordPage(res, { requestId: request.id, appName: client.name, handle: shownHandle, error, status });
    try {
      const user = await localAccountFor(shownHandle);
      if (!user || !user.password_hash) {
        retry('Wrong handle or password.');
        return;
      }
      const check = await checkPasswordWithLockout(user.id, user.password_hash, password);
      if (!check.ok) {
        if (check.reason === 'locked') {
          retry(`Too many failed attempts. Try again in ${Math.ceil(check.retryAfterSeconds / 60)} minute(s).`, 429);
        } else {
          retry('Wrong handle or password.');
        }
        return;
      }
      // The same gates as createSession: only an approved account signs in,
      // and only with a verified email where the server requires one.
      if (user.status !== 'approved') {
        retry(user.status === 'suspended' || user.status === 'takendown'
          ? 'This account cannot sign in.'
          : 'This account is not active yet.', 403);
        return;
      }
      if (runtimeSettings().emailVerificationPolicy === 'require-for-login' && !user.email_verified) {
        retry('Verify your email address before signing in.', 403);
        return;
      }
      await recordSignIn(request.id, user.did, null, 'password');
      res.redirect(303, `/oidc/authorize/continue?request=${encodeURIComponent(request.id)}`);
    } catch (err) {
      console.error('OIDC password sign-in error:', err);
      retry('Something went wrong. Try again.', 500);
    }
  });

  router.get('/oidc/authorize/continue', pageLimiter, async (req: Request, res: Response) => {
    const id = String(req.query.request ?? '');
    const request = await getOpenRequest(id, browserToken(req, id));
    const client = request ? await getClient(request.clientId) : null;
    if (!request || !client || !request.did) {
      errorPage(res, 400, 'This sign-in has expired', 'Go back to the app and start again.');
      return;
    }
    try {
      if (client.communityDid && !(await isCommunityMember(client.communityDid, request.did))) {
        clearBrowserCookie(res, request.id);
        redirectError(res, request.redirectUri, 'access_denied',
          `Only members of ${await communityName(client.communityDid)} can sign in to ${client.name}`, request.state);
        return;
      }
      const code = await issueCode(request.id);
      if (!code) {
        errorPage(res, 400, 'This sign-in has expired', 'Go back to the app and start again.');
        return;
      }
      await auditLog('oidc.signIn', request.did, null, { clientId: client.clientId, source: request.authSource });
      clearBrowserCookie(res, request.id);
      const url = new URL(request.redirectUri);
      url.searchParams.set('code', code);
      if (request.state) url.searchParams.set('state', request.state);
      url.searchParams.set('iss', oidcIssuer());
      res.redirect(303, url.toString());
    } catch (err) {
      console.error('OIDC continue error:', err);
      errorPage(res, 500, 'Something went wrong', 'Go back to the app and start again.');
    }
  });

  router.post('/oidc/token', tokenLimiter, form, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const fail = (status: number, error: string, description: string) => {
      if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="oidc"');
      res.status(status).json({ error, error_description: description });
    };
    try {
      // Client authentication: HTTP Basic (RFC 6749 §2.3.1, form-encoded parts) or body.
      let clientId: string | undefined;
      let secret: string | undefined;
      const auth = req.headers.authorization;
      if (auth?.startsWith('Basic ')) {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
        const sep = decoded.indexOf(':');
        if (sep > 0) {
          clientId = decodeURIComponent(decoded.slice(0, sep).replace(/\+/g, ' '));
          secret = decodeURIComponent(decoded.slice(sep + 1).replace(/\+/g, ' '));
        }
      } else if (typeof req.body?.client_id === 'string' && typeof req.body?.client_secret === 'string') {
        clientId = req.body.client_id;
        secret = req.body.client_secret;
      }
      if (!clientId || !secret) return fail(401, 'invalid_client', 'Client authentication is required');
      const client = await authenticateClient(clientId, secret);
      if (!client) return fail(401, 'invalid_client', 'Unknown client or wrong secret');

      if (req.body?.grant_type !== 'authorization_code') {
        return fail(400, 'unsupported_grant_type', 'Only authorization_code is supported');
      }
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const redirectUri = typeof req.body?.redirect_uri === 'string' ? req.body.redirect_uri : '';
      const verifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : undefined;
      const request = code ? await redeemCode(code, client.clientId, redirectUri, verifier) : null;
      if (!request || !request.did) return fail(400, 'invalid_grant', 'The code is invalid, expired, already used, or not for this client');

      const scopes = grantedScopes(request, client);
      let person: SignedInPerson;
      if (request.authSource === 'password') {
        const u = await query<{ did: string; handle: string; email: string | null; verified: boolean }>(
          'SELECT did, handle, email, (email_verified_at IS NOT NULL) AS verified FROM users WHERE did = $1',
          [request.did],
        );
        const row = u.rows[0];
        if (!row) return fail(400, 'invalid_grant', 'The account no longer exists');
        person = await localPerson({ did: row.did, handle: row.handle, email: row.email, emailVerified: row.verified });
      } else {
        person = await remotePerson(
          request.did,
          request.remoteEmail ? { email: request.remoteEmail, emailVerified: request.remoteEmailVerified } : null,
        );
      }
      const claims = claimsFor(person, scopes);
      const issuer = oidcIssuer();
      const idToken = await signIdToken({ issuer, clientId: client.clientId, claims, nonce: request.nonce, authTime: request.authTime });
      const accessToken = await signAccessToken({ issuer, clientId: client.clientId, scope: scopes.join(' '), claims });
      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        id_token: idToken,
        scope: scopes.join(' '),
      });
    } catch (err) {
      console.error('OIDC token error:', err);
      fail(500, 'server_error', 'Could not issue tokens');
    }
  });

  const userinfo = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const claims = token ? await verifyAccessToken(oidcIssuer(), token) : null;
    if (!claims) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      res.status(401).json({ error: 'invalid_token', error_description: 'Missing, invalid or expired access token' });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(claims);
  };
  router.get('/oidc/userinfo', tokenLimiter, userinfo);
  router.post('/oidc/userinfo', tokenLimiter, form, userinfo);

  return router;
}
