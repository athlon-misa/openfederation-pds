import crypto from 'crypto';
import { query } from '../db/client.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';
import type { VaultShare, VaultAuditEntry } from './vault-types.js';

/**
 * Store a Shamir share encrypted at rest.
 * Upserts — if a share already exists for (userDid, shareIndex), it is replaced.
 */
export async function storeShare(
  userDid: string,
  shareIndex: number,
  shareData: string,
  holder: 'device' | 'vault' | 'escrow',
  escrowProviderDid?: string,
  recoveryTier: number = 1
): Promise<void> {
  const plaintext = Buffer.from(shareData, 'utf-8');
  const encrypted = await encryptKeyBytes(plaintext, 'vault.share');
  const id = crypto.randomUUID();

  await query(
    `INSERT INTO vault_shares (id, user_did, share_index, encrypted_share, share_holder, escrow_provider_did, recovery_tier)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_did, share_index) DO UPDATE SET
       encrypted_share = $4,
       share_holder = $5,
       escrow_provider_did = $6,
       recovery_tier = $7,
       updated_at = CURRENT_TIMESTAMP`,
    [id, userDid, shareIndex, encrypted, holder, escrowProviderDid || null, recoveryTier]
  );
}

/**
 * Retrieve and decrypt a single share by user DID and share index.
 * Returns the decrypted share string, or null if not found.
 */
export async function getShare(userDid: string, shareIndex: number): Promise<string | null> {
  const result = await query<{ encrypted_share: Buffer }>(
    'SELECT encrypted_share FROM vault_shares WHERE user_did = $1 AND share_index = $2',
    [userDid, shareIndex]
  );
  if (result.rows.length === 0) return null;
  const decrypted = await decryptKeyBytes(result.rows[0].encrypted_share, 'vault.share');
  return decrypted.toString('utf-8');
}

/**
 * List share metadata for a user (does NOT return decrypted content).
 */
export async function getUserShares(userDid: string): Promise<VaultShare[]> {
  const result = await query<{
    id: string;
    user_did: string;
    share_index: number;
    share_holder: string;
    escrow_provider_did: string | null;
    recovery_tier: number;
    created_at: string;
  }>(
    `SELECT id, user_did, share_index, share_holder, escrow_provider_did, recovery_tier, created_at
     FROM vault_shares WHERE user_did = $1 ORDER BY share_index`,
    [userDid]
  );

  return result.rows.map(row => ({
    id: row.id,
    userDid: row.user_did,
    shareIndex: row.share_index,
    shareHolder: row.share_holder as 'device' | 'vault' | 'escrow',
    escrowProviderDid: row.escrow_provider_did || undefined,
    recoveryTier: row.recovery_tier,
    createdAt: row.created_at,
  }));
}

/**
 * Append-only vault audit log entry.
 */
export async function logVaultAudit(
  userDid: string,
  action: string,
  actorDid?: string,
  shareIndex?: number,
  metadata?: Record<string, unknown>
): Promise<void> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO vault_audit_log (id, user_did, action, actor_did, share_index, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userDid, action, actorDid || null, shareIndex ?? null, metadata ? JSON.stringify(metadata) : null]
  );
}

/**
 * Read vault audit entries for a user.
 */
export async function getVaultAuditLog(userDid: string, limit: number = 50): Promise<VaultAuditEntry[]> {
  const result = await query<{
    id: string;
    user_did: string;
    action: string;
    actor_did: string | null;
    share_index: number | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>(
    `SELECT id, user_did, action, actor_did, share_index, metadata, created_at
     FROM vault_audit_log WHERE user_did = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userDid, limit]
  );

  return result.rows.map(row => ({
    id: row.id,
    userDid: row.user_did,
    action: row.action,
    actorDid: row.actor_did || undefined,
    shareIndex: row.share_index ?? undefined,
    metadata: row.metadata || undefined,
    createdAt: row.created_at,
  }));
}

/**
 * Update the share holder and optional escrow provider for an existing share.
 */
export async function updateShareHolder(
  userDid: string,
  shareIndex: number,
  holder: 'device' | 'vault' | 'escrow',
  escrowProviderDid?: string
): Promise<boolean> {
  const result = await query(
    `UPDATE vault_shares SET share_holder = $3, escrow_provider_did = $4, updated_at = CURRENT_TIMESTAMP
     WHERE user_did = $1 AND share_index = $2`,
    [userDid, shareIndex, holder, escrowProviderDid || null]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Update the recovery tier for all shares of a user.
 */
export async function updateRecoveryTier(userDid: string, tier: number): Promise<void> {
  await query(
    'UPDATE vault_shares SET recovery_tier = $2, updated_at = CURRENT_TIMESTAMP WHERE user_did = $1',
    [userDid, tier]
  );
}
