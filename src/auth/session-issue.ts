import crypto from 'crypto';
import { query } from '../db/client.js';
import { signAccessToken, generateRefreshToken, refreshTtlMs } from './tokens.js';
import type { UserRole, UserStatus } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Expiry for a pseudonym session: the first UTC midnight at or after
 * now + TTL. Never shorter than the TTL, and only day-granular so the
 * value cannot be used to line up a pseudonym's login with its owner's.
 */
export function pseudonymSessionExpiry(nowMs: number = Date.now()): Date {
  return new Date(Math.ceil((nowMs + refreshTtlMs()) / DAY_MS) * DAY_MS);
}

/**
 * Mint access + refresh tokens and persist the session row.
 * Pseudonym sessions carry no creation time and a day-rounded expiry, so the
 * sessions table cannot link a pseudonym to its owner by timing.
 */
export async function issueSession(user: {
  id: string; handle: string; email: string | null; did: string; status: string; token_version: number;
}, opts: { pseudonym?: boolean } = {}): Promise<{ accessJwt: string; refreshJwt: string; roles: UserRole[] }> {
  const roles = (await query<{ role: UserRole }>('SELECT role FROM user_roles WHERE user_id = $1', [user.id])).rows.map((r) => r.role);
  const accessJwt = await signAccessToken({
    userId: user.id, handle: user.handle, email: user.email ?? '', did: user.did,
    status: user.status as UserStatus, roles, tokenVersion: user.token_version,
  });
  const { token: refreshJwt, hash } = generateRefreshToken();
  if (opts.pseudonym) {
    await query('INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, NULL)',
      [crypto.randomUUID(), user.id, hash, pseudonymSessionExpiry().toISOString()]);
  } else {
    await query('INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [crypto.randomUUID(), user.id, hash, new Date(Date.now() + refreshTtlMs()).toISOString()]);
  }
  return { accessJwt, refreshJwt, roles };
}
