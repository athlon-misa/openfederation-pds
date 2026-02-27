/**
 * External user login routes.
 *
 * Handles the OAuth callback from remote ATProto PDSes and exchanges
 * the authorization code for local JWT tokens.
 *
 * Flow:
 *   1. Frontend calls resolveExternal XRPC → backend calls client.authorize(handle)
 *   2. User redirected to remote PDS consent page
 *   3. Remote PDS redirects to /oauth/external/callback
 *   4. Backend processes callback → creates/finds local user → issues temp code
 *   5. Backend redirects to frontend /callback?code={temp}
 *   6. Frontend calls POST /oauth/external/complete → gets local JWT tokens
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getExternalOAuthClient, getClientMetadata } from './external-client.js';
import { query } from '../db/client.js';
import { signAccessToken, generateRefreshToken, refreshTtlMs } from '../auth/tokens.js';
import type { UserRole, UserStatus } from '../auth/types.js';
import { DidResolver } from '@atproto/identity';

// Temporary code store for the OAuth callback → frontend handoff.
// Codes expire after 60 seconds — this is an in-memory store since codes
// are consumed immediately by the frontend callback page.
const pendingCodes = new Map<string, { tokens: LocalTokens; expiresAt: number }>();

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

export function createExternalOAuthRouter(): Router {
  const router = Router();

  // Serve client metadata document for remote PDSes to fetch
  router.get('/oauth/client-metadata.json', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'max-age=600');
    res.json(getClientMetadata());
  });

  // OAuth callback from remote PDS
  router.get('/oauth/external/callback', async (req: Request, res: Response) => {
    const client = getExternalOAuthClient();
    if (!client) {
      return res.status(503).json({ error: 'ServiceUnavailable', message: 'OAuth client not initialized' });
    }

    try {
      const params = new URLSearchParams(req.query as Record<string, string>);
      const { session } = await client.callback(params);
      const did = session.did;

      // Create or find local user for this external DID
      const localTokens = await ensureExternalUser(did, session);

      // Generate a temporary code for the frontend to exchange
      const tempCode = crypto.randomBytes(32).toString('hex');
      pendingCodes.set(tempCode, {
        tokens: localTokens,
        expiresAt: Date.now() + 60_000, // 60 seconds
      });

      // Determine frontend URL for redirect
      const frontendUrl = (process.env.CORS_ORIGINS || 'http://localhost:3001').split(',')[0].trim();
      const redirectUrl = new URL('/callback', frontendUrl);
      redirectUrl.searchParams.set('code', tempCode);

      res.redirect(redirectUrl.toString());
    } catch (err) {
      console.error('External OAuth callback error:', err);
      const frontendUrl = (process.env.CORS_ORIGINS || 'http://localhost:3001').split(',')[0].trim();
      const errorUrl = new URL('/callback', frontendUrl);
      errorUrl.searchParams.set('error', 'oauth_callback_failed');
      res.redirect(errorUrl.toString());
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
