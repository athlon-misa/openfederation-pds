/**
 * Owner-side account deletion (#269).
 *
 * Who may delete:
 *  - an active (approved) account: the standard case;
 *  - a deactivated copy whose DID names another server: left behind by a move
 *    away, or an abandoned move here. The DID says where the account lives,
 *    so removing this copy loses nothing the owner does not hold elsewhere.
 * Never a deactivated account the DID still names here (reactivate first: it
 * may be the only copy), a suspended or taken-down one (moderation decides,
 * docs/FAIR-USE.md), a pending or rejected sign-up, or an admin account.
 */
import { createHash, randomInt } from 'node:crypto';
import { query, withTransaction } from '../db/client.js';
import { currentPlcState } from './account-migration.js';
import { homeOf } from '../community/migration.js';
import { deleteAccountData, removeBlobFiles } from './delete-account.js';
import { invalidateAuthContext } from '../auth/auth-context-cache.js';

export const DELETE_CODE_TTL_MS = 15 * 60 * 1000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export class DeleteRefusal extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

/** A code like `K7QX2-MZ4PA`: 50 bits, typed from an email. */
export function newDeleteCode(): string {
  const pick = () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

export function hashDeleteCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

export interface DeletableAccount { id: string; did: string; status: string; passwordHash: string | null; pseudonymOwnerKey: string | null; isAdmin: boolean }

export async function findAccount(did: string): Promise<DeletableAccount | null> {
  const row = (await query<{ id: string; status: string; password_hash: string | null; pseudonym_owner_key: string | null; is_admin: boolean }>(
    `SELECT u.id, u.status, u.password_hash, u.pseudonym_owner_key,
            EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'admin') AS is_admin
     FROM users u WHERE u.did = $1`, [did])).rows[0];
  return row ? { id: row.id, did, status: row.status, passwordHash: row.password_hash, pseudonymOwnerKey: row.pseudonym_owner_key, isAdmin: row.is_admin } : null;
}

/** Throws a DeleteRefusal unless the owner may delete this account now. */
export async function assertDeletable(account: DeletableAccount): Promise<void> {
  if (account.isAdmin) throw new DeleteRefusal(400, 'InvalidRequest', 'An admin account cannot delete itself');
  if (account.status === 'suspended' || account.status === 'takendown') {
    throw new DeleteRefusal(400, 'AccountModerated', 'This account is under moderation and cannot be deleted by its owner');
  }
  if (account.status === 'approved') return;
  if (account.status !== 'deactivated') {
    throw new DeleteRefusal(400, 'InvalidRequest', 'This account cannot be deleted in its current state');
  }
  let state;
  try {
    state = await currentPlcState(account.did);
  } catch {
    throw new DeleteRefusal(503, 'UpstreamFailure', 'The PLC directory could not be reached to check where this account lives');
  }
  if (!state || !homeOf(state)) {
    throw new DeleteRefusal(400, 'AccountDeactivated',
      'This account is deactivated and its DID still names this server; reactivate it (com.atproto.server.activateAccount) before deleting it');
  }
}

export async function deleteOwnAccount(account: DeletableAccount): Promise<void> {
  const blobs = await withTransaction((client) => deleteAccountData(client, { id: account.id, did: account.did }));
  await removeBlobFiles(blobs);
  invalidateAuthContext(account.did);
}
