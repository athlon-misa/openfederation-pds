import { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { Secp256k1Keypair } from '@atproto/crypto';
import { query, withTransaction } from '../db/client.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';

const MAX_RESERVATIONS = 10_000;

/**
 * AT Protocol reserveSigningKey. The caller names this key as
 * verificationMethods.atproto in its own PLC genesis op, then creates the
 * account. Unauthenticated (the account does not exist yet) and rate
 * limited. Rows carry no timestamp (seq is a plain insertion counter); the
 * table is capped FIFO by seq, keeping the newest rows, so an unused
 * reservation eventually disappears.
 *
 * With `did`, the reservation is for that DID (account migration): it
 * replaces any earlier one for the DID and is consumed by createAccount.
 * Without it, the reservation stays anonymous, as pseudonym creation needs.
 */
export default async function reserveSigningKey(req: Request, res: Response): Promise<void> {
  // The optional `did` input is informational only, but must be a DID when present
  // (the lexicon declares format "did"; the runtime validator does not check formats).
  const did = req.body?.did;
  if (did !== undefined && (typeof did !== 'string' || !/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(did))) {
    res.status(400).json({ error: 'InvalidRequest', message: 'did must be a DID' });
    return;
  }
  try {
    const keypair = await Secp256k1Keypair.create({ exportable: true });
    const encrypted = await encryptKeyBytes(Buffer.from(await keypair.export()), 'identity.signing-key');
    await withTransaction(async (client) => {
      if (did !== undefined) await client.query('DELETE FROM reserved_signing_keys WHERE did = $1', [did]);
      await client.query('INSERT INTO reserved_signing_keys (signing_key, key_bytes, did) VALUES ($1, $2, $3)',
        [keypair.did(), encrypted, did ?? null]);
    });
    await query(
      `DELETE FROM reserved_signing_keys WHERE seq IN (
         SELECT seq FROM reserved_signing_keys ORDER BY seq DESC OFFSET $1)`, [MAX_RESERVATIONS]);
    res.status(200).json({ signingKey: keypair.did() });
  } catch (error) {
    console.error('Error in reserveSigningKey:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to reserve signing key' });
  }
}

/** Atomically take a reservation; null when unknown. */
export async function consumeReservedSigningKey(client: PoolClient, signingKey: string): Promise<Buffer | null> {
  const row = await client.query<{ key_bytes: Buffer }>(
    'DELETE FROM reserved_signing_keys WHERE signing_key = $1 RETURNING key_bytes', [signingKey]);
  if (row.rows.length === 0) return null;
  return decryptKeyBytes(row.rows[0].key_bytes, 'identity.signing-key');
}

/** Atomically take the reservation made for this DID; null when there is none. */
export async function consumeReservedSigningKeyForDid(
  client: PoolClient, did: string,
): Promise<{ signingKey: string; keyBytes: Buffer } | null> {
  const row = await client.query<{ signing_key: string; key_bytes: Buffer }>(
    'DELETE FROM reserved_signing_keys WHERE did = $1 RETURNING signing_key, key_bytes', [did]);
  if (row.rows.length === 0) return null;
  return { signingKey: row.rows[0].signing_key, keyBytes: await decryptKeyBytes(row.rows[0].key_bytes, 'identity.signing-key') };
}
