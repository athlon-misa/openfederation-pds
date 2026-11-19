/**
 * A remembered sign-in for apps (#462; ADR-005 decision 9, as amended).
 *
 * After someone signs in to an app through the OpenID Connect provider, the
 * browser keeps a random token (cookie `ofd_oidcsession`, path /oidc) and the
 * next app offers "Continue as …" instead of asking for the account again.
 * Only the token's SHA-256 is stored.
 *
 * An account of this server is checked again on every use: still approved,
 * still allowed to sign in under the email policy, and `users.token_version`
 * unchanged since the sign-in, so every event that ends all of an account's
 * sessions (password change or reset, recovery, sign-out, refresh-token
 * reuse, suspension, takedown) ends this one as well. An account of another
 * server can only be checked by its own server; its remembered sign-in lasts
 * until it expires or the person signs out of an app.
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { parseCookies } from '../auth/utils.js';
import { runtimeSettings } from '../settings/runtime-settings.js';

export const SESSION_COOKIE = 'ofd_oidcsession';

export interface RememberedSignIn {
  did: string;
  authSource: 'password' | 'atproto';
  authTime: Date;
  remoteEmail: string | null;
  remoteEmailVerified: boolean;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sessionsEnabled(): boolean {
  return config.oidc.sessionDays > 0;
}

function sessionToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

export function clearSessionCookie(res: Response): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/oidc; Max-Age=0`);
}

/** Remember a completed sign-in in this browser. */
export async function rememberSignIn(res: Response, signIn: {
  did: string;
  authSource: 'password' | 'atproto';
  authTime: Date | null;
  remoteEmail: string | null;
  remoteEmailVerified: boolean;
}): Promise<void> {
  if (!sessionsEnabled()) return;
  let tokenVersion: number | null = null;
  if (signIn.authSource === 'password') {
    const u = await query<{ token_version: number }>('SELECT token_version FROM users WHERE did = $1', [signIn.did]);
    if (!u.rows[0]) return;
    tokenVersion = u.rows[0].token_version;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const seconds = config.oidc.sessionDays * 24 * 60 * 60;
  // Housekeeping: forget remembered sign-ins that have run out.
  await query('DELETE FROM oidc_sessions WHERE expires_at < NOW()');
  await query(
    `INSERT INTO oidc_sessions (id_hash, did, auth_source, token_version, remote_email, remote_email_verified, auth_time, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()), NOW() + make_interval(secs => $8))`,
    [sha256(token), signIn.did, signIn.authSource, tokenVersion,
      signIn.authSource === 'atproto' ? signIn.remoteEmail : null,
      signIn.authSource === 'atproto' && signIn.remoteEmailVerified,
      signIn.authTime, seconds],
  );
  const secure = config.env.isProduction ? '; Secure' : '';
  res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/oidc; Max-Age=${seconds}${secure}`);
}

/**
 * The remembered sign-in of this browser, if it may still be used: not
 * expired, and for an account of this server still approved, allowed by the
 * email policy and not signed out everywhere since. Null otherwise; a session
 * that may not be used any more is deleted.
 */
export async function rememberedSignIn(req: Request): Promise<RememberedSignIn | null> {
  if (!sessionsEnabled()) return null;
  const token = sessionToken(req);
  if (!token || token.length > 128) return null;
  const hash = sha256(token);
  const r = await query<{
    did: string; auth_source: 'password' | 'atproto'; token_version: number | null; auth_time: string;
    remote_email: string | null; remote_email_verified: boolean;
    user_status: string | null; user_token_version: number | null; email_verified: boolean | null;
  }>(
    `SELECT s.did, s.auth_source, s.token_version, s.auth_time, s.remote_email, s.remote_email_verified,
            u.status AS user_status, u.token_version AS user_token_version,
            (u.email_verified_at IS NOT NULL) AS email_verified
       FROM oidc_sessions s
       LEFT JOIN users u ON u.did = s.did
      WHERE s.id_hash = $1 AND s.expires_at > NOW()`,
    [hash],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.auth_source === 'password') {
    const stillAllowed = row.user_status === 'approved'
      && row.token_version !== null
      && row.user_token_version === row.token_version
      && !(runtimeSettings().emailVerificationPolicy === 'require-for-login' && !row.email_verified);
    if (!stillAllowed) {
      await query('DELETE FROM oidc_sessions WHERE id_hash = $1', [hash]);
      return null;
    }
  }
  return {
    did: row.did,
    authSource: row.auth_source,
    authTime: new Date(row.auth_time),
    remoteEmail: row.remote_email,
    remoteEmailVerified: row.remote_email_verified === true,
  };
}

/** Forget this browser's remembered sign-in (signing out of an app). */
export async function forgetSignIn(req: Request, res: Response): Promise<void> {
  const token = sessionToken(req);
  if (token && token.length <= 128) {
    await query('DELETE FROM oidc_sessions WHERE id_hash = $1', [sha256(token)]);
  }
  clearSessionCookie(res);
}
