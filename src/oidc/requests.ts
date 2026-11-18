/**
 * One sign-in, from the app's authorization request to the code it redeems
 * (ADR-005, decision 8).
 *
 * The request lives in `oidc_requests`. It is bound to the browser that
 * started it by a random cookie whose hash is stored with it, so a link to a
 * half-finished sign-in is useless to anyone else, and a person cannot be
 * signed in to an app as somebody else by being sent someone's callback. The
 * code is single-use, lives 60 seconds and is bound to the client, the
 * redirect URI and the PKCE challenge.
 */
import crypto from 'crypto';
import { query } from '../db/client.js';

export const REQUEST_TTL_SECONDS = 600;
export const CODE_TTL_SECONDS = 60;

export interface OidcRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  codeChallenge: string | null;
  did: string | null;
  handle: string | null;
  authSource: 'password' | 'atproto' | null;
  authTime: Date | null;
}

interface Row {
  id: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  code_challenge: string | null;
  did: string | null;
  handle: string | null;
  auth_source: 'password' | 'atproto' | null;
  auth_time: string | null;
  browser_hash: string;
}

function fromRow(r: Row): OidcRequest {
  return {
    id: r.id,
    clientId: r.client_id,
    redirectUri: r.redirect_uri,
    scope: r.scope,
    state: r.state,
    nonce: r.nonce,
    codeChallenge: r.code_challenge,
    did: r.did,
    handle: r.handle,
    authSource: r.auth_source,
    authTime: r.auth_time ? new Date(r.auth_time) : null,
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf-8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export interface NewRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  codeChallenge: string | null;
}

/** Start a sign-in. Returns its id and the browser cookie value that binds it. */
export async function createRequest(input: NewRequest): Promise<{ id: string; browserToken: string }> {
  const id = crypto.randomBytes(18).toString('base64url');
  const browserToken = crypto.randomBytes(24).toString('base64url');
  // Housekeeping: forget sign-ins nobody finished.
  await query('DELETE FROM oidc_requests WHERE expires_at < NOW()');
  await query(
    `INSERT INTO oidc_requests (id, browser_hash, client_id, redirect_uri, scope, state, nonce, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + make_interval(secs => $9))`,
    [id, sha256(browserToken), input.clientId, input.redirectUri, input.scope,
      input.state, input.nonce, input.codeChallenge, REQUEST_TTL_SECONDS],
  );
  return { id, browserToken };
}

/**
 * The request, when it exists, has not expired, has no code yet and belongs
 * to this browser. Anything else is null: the caller shows "start again".
 */
export async function getOpenRequest(id: string, browserToken: string | undefined): Promise<OidcRequest | null> {
  if (!id || !browserToken) return null;
  const r = await query<Row>(
    `SELECT id, client_id, redirect_uri, scope, state, nonce, code_challenge, did, handle, auth_source, auth_time, browser_hash
     FROM oidc_requests WHERE id = $1 AND expires_at > NOW() AND code_hash IS NULL`,
    [id],
  );
  const row = r.rows[0];
  if (!row || !safeEqualHex(sha256(browserToken), row.browser_hash)) return null;
  return fromRow(row);
}

/** The request without the browser check, for the AT Protocol callback (it re-checks on continue). */
export async function getRequestById(id: string): Promise<OidcRequest | null> {
  const r = await query<Row>(
    `SELECT id, client_id, redirect_uri, scope, state, nonce, code_challenge, did, handle, auth_source, auth_time, browser_hash
     FROM oidc_requests WHERE id = $1 AND expires_at > NOW() AND code_hash IS NULL`,
    [id],
  );
  return r.rows[0] ? fromRow(r.rows[0]) : null;
}

/** Record who signed in. Only once per request. */
export async function recordSignIn(id: string, did: string, handle: string | null, source: 'password' | 'atproto'): Promise<boolean> {
  const r = await query(
    `UPDATE oidc_requests SET did = $2, handle = $3, auth_source = $4, auth_time = NOW()
     WHERE id = $1 AND did IS NULL AND code_hash IS NULL AND expires_at > NOW()`,
    [id, did, handle, source],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Issue the code for a signed-in request. */
export async function issueCode(id: string): Promise<string | null> {
  const code = crypto.randomBytes(32).toString('base64url');
  const r = await query(
    `UPDATE oidc_requests SET code_hash = $2, code_expires_at = NOW() + make_interval(secs => $3)
     WHERE id = $1 AND did IS NOT NULL AND code_hash IS NULL AND expires_at > NOW()`,
    [id, sha256(code), CODE_TTL_SECONDS],
  );
  return (r.rowCount ?? 0) > 0 ? code : null;
}

export type RedeemFailure = 'invalid_grant';

/**
 * Redeem a code: exactly once, before it expires, for the same client and
 * redirect URI, and with the PKCE verifier when a challenge was sent. The
 * request is deleted whatever the outcome, so a code that fails a check
 * cannot be tried again.
 */
export async function redeemCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string | undefined,
): Promise<OidcRequest | null> {
  const r = await query<Row & { code_expires_at: string }>(
    `DELETE FROM oidc_requests WHERE code_hash = $1
     RETURNING id, client_id, redirect_uri, scope, state, nonce, code_challenge, did, handle, auth_source, auth_time, browser_hash, code_expires_at`,
    [sha256(code)],
  );
  const row = r.rows[0];
  if (!row || !row.did) return null;
  if (new Date(row.code_expires_at).getTime() < Date.now()) return null;
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) return null;
  if (row.code_challenge) {
    if (!codeVerifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) return null;
    const challenge = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const a = Buffer.from(challenge);
    const b = Buffer.from(row.code_challenge);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  }
  return fromRow(row);
}
