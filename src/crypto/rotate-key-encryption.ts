/**
 * Re-wrap every key stored at rest under the current KEY_ENCRYPTION_SECRET.
 *
 * Rotation: set KEY_ENCRYPTION_SECRET to the new secret and
 * KEY_ENCRYPTION_SECRET_PREVIOUS to the old one, restart (both open keys
 * meanwhile), run scripts/rotate-key-encryption-secret.ts --apply, then remove
 * KEY_ENCRYPTION_SECRET_PREVIOUS. Keys in the legacy pre-purpose format are
 * upgraded on the way. Safe while the server runs: a row is only updated if
 * it still holds the value that was read.
 */
import { query } from '../db/client.js';
import { config } from '../config.js';
import { needsRewrap, unwrapKeyBytes, wrapKeyBytes, type KeyWrapPurpose } from './key-wrap.js';

export interface EncryptedKeyColumn {
  table: string;
  key: string;
  column: string;
  purpose: KeyWrapPurpose;
  /** How the wrapped bytes are stored. */
  encoding: 'bytea' | 'base64';
}

/** Every column holding a key wrapped by src/crypto/key-wrap.ts. Add new ones here. */
export const ENCRYPTED_KEY_COLUMNS: readonly EncryptedKeyColumn[] = [
  { table: 'plc_keys', key: 'community_did', column: 'recovery_key_bytes', purpose: 'identity.recovery-key', encoding: 'bytea' },
  { table: 'signing_keys', key: 'community_did', column: 'signing_key_bytes', purpose: 'identity.signing-key', encoding: 'bytea' },
  { table: 'user_signing_keys', key: 'user_did', column: 'signing_key_bytes', purpose: 'identity.signing-key', encoding: 'bytea' },
  { table: 'reserved_signing_keys', key: 'signing_key', column: 'key_bytes', purpose: 'identity.signing-key', encoding: 'bytea' },
  { table: 'reserved_rotation_keys', key: 'rotation_key', column: 'key_bytes', purpose: 'identity.recovery-key', encoding: 'bytea' },
  { table: 'ap_signing_keys', key: 'did', column: 'encrypted_private_key', purpose: 'activitypub.signing-key', encoding: 'bytea' },
  { table: 'pds_service_keys', key: 'id', column: 'private_key_encrypted', purpose: 'identity.pds-service-key', encoding: 'bytea' },
  { table: 'wallet_custody', key: 'id', column: 'private_key_encrypted', purpose: 'wallet.custodial-key', encoding: 'bytea' },
  { table: 'vault_shares', key: 'id', column: 'encrypted_share', purpose: 'vault.share', encoding: 'bytea' },
  { table: 'attestation_encryption', key: 'id', column: 'encrypted_dek_issuer', purpose: 'attestation.dek', encoding: 'base64' },
  { table: 'attestation_encryption', key: 'id', column: 'encrypted_dek_subject', purpose: 'attestation.dek', encoding: 'base64' },
  { table: 'pseudonym_token_keys', key: 'epoch', column: 'private_pkcs8', purpose: 'pseudonym.token-key', encoding: 'bytea' },
];

export interface RotationResult {
  /** Keys not yet under the current secret (or still in the legacy format). */
  toRotate: number;
  /** Keys re-wrapped (only with apply). */
  rotated: number;
  /** Keys neither secret opens: listed, never touched. */
  failed: Array<{ table: string; column: string; key: string; error: string }>;
  /** Rows changed by someone else between read and write; run again. */
  raced: number;
}

export async function rotateKeyEncryption(opts: {
  apply: boolean;
  log?: (line: string) => void;
  /** Limit the run to these primary keys per table (tables not listed are skipped). */
  only?: Record<string, string[]>;
}): Promise<RotationResult> {
  const current = config.keyEncryptionSecret;
  if (!current) throw new Error('KEY_ENCRYPTION_SECRET must be set');
  const result: RotationResult = { toRotate: 0, rotated: 0, failed: [], raced: 0 };
  const log = opts.log ?? (() => {});

  for (const c of ENCRYPTED_KEY_COLUMNS) {
    const restrict = opts.only ? opts.only[c.table] : undefined;
    if (opts.only && !restrict) continue;
    // Table and column names come from the constant list above, never from input.
    const rows = (await query<{ k: string; v: Buffer | string }>(
      `SELECT ${c.key}::text AS k, ${c.column} AS v FROM ${c.table} WHERE ${c.column} IS NOT NULL`
        + (restrict ? ` AND ${c.key}::text = ANY($1)` : ''),
      restrict ? [restrict] : [],
    )).rows;
    let pending = 0;
    for (const row of rows) {
      const bundle = c.encoding === 'base64' ? Buffer.from(row.v as string, 'base64') : (row.v as Buffer);
      if (!(await needsRewrap(bundle, c.purpose, current))) continue;
      let plaintext: Buffer;
      try {
        plaintext = await unwrapKeyBytes(bundle, c.purpose);
      } catch (err) {
        result.failed.push({ table: c.table, column: c.column, key: row.k, error: (err as Error).message });
        continue;
      }
      result.toRotate++;
      pending++;
      if (!opts.apply) continue;
      const rewrapped = await wrapKeyBytes(plaintext, c.purpose);
      plaintext.fill(0);
      const next = c.encoding === 'base64' ? rewrapped.toString('base64') : rewrapped;
      const updated = await query(
        `UPDATE ${c.table} SET ${c.column} = $1 WHERE ${c.key}::text = $2 AND ${c.column} = $3`,
        [next, row.k, row.v],
      );
      if (updated.rowCount === 1) result.rotated++;
      else result.raced++;
    }
    log(`${c.table}.${c.column}: ${rows.length} keys, ${pending} ${opts.apply ? 're-wrapped' : 'to re-wrap'}`);
  }
  return result;
}
