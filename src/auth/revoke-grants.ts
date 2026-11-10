import type { PoolClient } from 'pg';
import { query } from '../db/client.js';
import { invalidateAuthContext } from './auth-context-cache.js';

/**
 * End every OAuth grant an account has given out.
 *
 * Local sessions are ended by revoking `sessions` rows and bumping
 * `token_version`. OAuth grants live elsewhere (`oauth_tokens`, keyed by the
 * account's DID) and are untouched by either, so anything that is meant to
 * lock everyone out (a password change or reset, "revoke all sessions", a
 * suspension or takedown, a detected refresh-token replay) has to end them
 * too. Otherwise a client authorised while an attacker had the password keeps
 * working after the owner has changed it.
 *
 * Also forgets the remembered sign-in on consent screens, and drops the cached
 * auth context so the change is seen on the next request.
 */
export async function revokeOAuthGrants(did: string, client?: PoolClient): Promise<number> {
  const run = client ? client.query.bind(client) : query;
  const tokens = await run(`DELETE FROM oauth_tokens WHERE data->>'sub' = $1`, [did]);
  await run('DELETE FROM oauth_device_accounts WHERE account_sub = $1', [did]);
  invalidateAuthContext(did);
  return tokens.rowCount ?? 0;
}
