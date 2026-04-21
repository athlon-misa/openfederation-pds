/**
 * Shared primitives for user account creation.
 *
 * Three entrypoints create accounts: the local register endpoint, the
 * partner-register endpoint, and the OAuth-provider account store.
 * They differ in rate limiting, invite handling, status, and what they
 * return — but the core steps (input validation, uniqueness check,
 * user+role insert, signing-key storage + repo initialization) are
 * identical. Those steps live here; drift between the three paths
 * is supposed to be visible at the call site, not buried inside each
 * copy of the same block.
 */

import type { PoolClient } from 'pg';
import { Secp256k1Keypair } from '@atproto/crypto';
import {
  isStrongPassword,
  isValidEmail,
  isValidHandle,
  normalizeEmail,
  normalizeHandle,
  passwordValidationMessage,
} from './utils.js';
import { storeUserSigningKey } from '../identity/user-identity.js';
import { RepoEngine } from '../repo/repo-engine.js';

export class RegistrationValidationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CredentialsInput {
  handle?: string;
  email?: string;
  password?: string;
}

export interface NormalizedCredentials {
  handle: string;
  email: string;
  password: string;
}

/**
 * Normalize and validate registration credentials. Returns normalized
 * `{handle, email, password}` or throws `RegistrationValidationError`.
 * Call sites convert the error into whatever transport they use (HTTP
 * response, thrown `Error` for OAuth).
 */
export function normalizeAndValidateCredentials(input: CredentialsInput): NormalizedCredentials {
  if (!input.handle || !input.email || !input.password) {
    throw new RegistrationValidationError(400, 'InvalidRequest', 'handle, email, and password are required');
  }
  const handle = normalizeHandle(input.handle);
  const email = normalizeEmail(input.email);
  if (!isValidHandle(handle)) {
    throw new RegistrationValidationError(
      400,
      'InvalidRequest',
      'Handle must be 3-30 characters, lowercase letters, numbers, and hyphens only. No leading/trailing hyphens or consecutive hyphens. Some names are reserved.',
    );
  }
  if (!isValidEmail(email)) {
    throw new RegistrationValidationError(400, 'InvalidRequest', 'Email is invalid');
  }
  if (!isStrongPassword(input.password)) {
    throw new RegistrationValidationError(400, 'InvalidRequest', passwordValidationMessage());
  }
  return { handle, email, password: input.password };
}

type QueryRunner = Pick<PoolClient, 'query'> | { query: PoolClient['query'] };

/**
 * Asserts that no existing user has the given handle or email. Throws
 * `RegistrationValidationError` with a 409 on conflict. Use the caller's
 * transaction client so the check is consistent with the subsequent insert.
 */
export async function ensureHandleEmailAvailable(
  client: QueryRunner,
  handle: string,
  email: string,
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE handle = $1 OR email = $2',
    [handle, email],
  );
  if (existing.rows.length > 0) {
    throw new RegistrationValidationError(409, 'AccountExists', 'Handle or email is already in use');
  }
}

export interface InsertUserParams {
  userId: string;
  handle: string;
  email: string;
  passwordHash: string | null;
  did: string;
  status: 'pending' | 'approved';
  authType?: 'local' | 'external';
  createdByPartner?: string | null;
}

/**
 * Insert the user row and default `user` role in one transactional step.
 * `approved_at` is set automatically when `status === 'approved'`.
 */
export async function insertUserWithRole(client: PoolClient, params: InsertUserParams): Promise<void> {
  const authType = params.authType ?? 'local';
  const isApproved = params.status === 'approved';
  await client.query(
    `INSERT INTO users
       (id, handle, email, password_hash, status, did, auth_type, created_by_partner, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${isApproved ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
    [
      params.userId,
      params.handle,
      params.email,
      params.passwordHash,
      params.status,
      params.did,
      authType,
      params.createdByPartner ?? null,
    ],
  );
  await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'user')`, [params.userId]);
}

/**
 * Store the user's signing key and create their initial repo with a
 * `app.bsky.actor.profile` record. Runs *outside* the user-insert
 * transaction — the PLC identity is already registered at this point,
 * and failures here don't invalidate the account (they're logged and
 * left for retry). Imports the keypair directly from raw bytes to skip
 * the PBKDF2 encrypt/decrypt round-trip.
 */
export async function initializeUserRepoAsync(
  did: string,
  handle: string,
  signingKeyBase64: string,
  opts: { description?: string } = {},
): Promise<void> {
  try {
    await storeUserSigningKey(did, signingKeyBase64);
    const keyBytes = Buffer.from(signingKeyBase64, 'base64');
    const keypair = await Secp256k1Keypair.import(keyBytes, { exportable: false });
    const engine = new RepoEngine(did);
    await engine.createRepo(keypair, [
      {
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
        record: { displayName: handle, description: opts.description ?? '' },
      },
    ]);
  } catch (err) {
    console.error(`Warning: failed to initialize user repo for ${did} (account still created):`, err);
  }
}
