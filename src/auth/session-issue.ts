import crypto from 'crypto';
import { query } from '../db/client.js';
import { signAccessToken, generateRefreshToken, refreshTtlMs } from './tokens.js';
import type { UserRole, UserStatus } from './types.js';

/** Mint access + refresh tokens and persist the session row. */
export async function issueSession(user: {
  id: string; handle: string; email: string | null; did: string; status: string; token_version: number;
}): Promise<{ accessJwt: string; refreshJwt: string; roles: UserRole[] }> {
  const roles = (await query<{ role: UserRole }>('SELECT role FROM user_roles WHERE user_id = $1', [user.id])).rows.map((r) => r.role);
  const accessJwt = await signAccessToken({
    userId: user.id, handle: user.handle, email: user.email ?? '', did: user.did,
    status: user.status as UserStatus, roles, tokenVersion: user.token_version,
  });
  const { token: refreshJwt, hash } = generateRefreshToken();
  await query('INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [crypto.randomUUID(), user.id, hash, new Date(Date.now() + refreshTtlMs()).toISOString()]);
  return { accessJwt, refreshJwt, roles };
}
