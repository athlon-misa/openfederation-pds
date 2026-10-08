import crypto from 'crypto';
import { query } from '../../src/db/client.js';
import { signAccessToken, generateRefreshToken, refreshTtlMs } from '../../src/auth/tokens.js';

export async function issueSessionForTests(u: { id: string; did: string; handle: string }) {
  const accessJwt = await signAccessToken({ userId: u.id, handle: u.handle, email: '', did: u.did, status: 'approved', roles: ['user'], tokenVersion: 0 });
  const { token: refreshJwt, hash } = generateRefreshToken();
  await query('INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [crypto.randomUUID(), u.id, hash, new Date(Date.now() + refreshTtlMs()).toISOString()]);
  return { accessJwt, refreshJwt };
}
