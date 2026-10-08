import { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { Secp256k1Keypair } from '@atproto/crypto';
import { query } from '../db/client.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';

const MAX_RESERVATIONS = 10_000;

/**
 * AT Protocol reserveSigningKey. The caller names this key as
 * verificationMethods.atproto in its own PLC genesis op, then creates the
 * account. Unauthenticated (the account does not exist yet) and rate
 * limited. Rows carry no timestamp (seq is a plain insertion counter); the
 * table is capped FIFO by seq, keeping the newest rows, so an unused
 * reservation eventually disappears.
 */
export default async function reserveSigningKey(_req: Request, res: Response): Promise<void> {
  try {
    const keypair = await Secp256k1Keypair.create({ exportable: true });
    const encrypted = await encryptKeyBytes(Buffer.from(await keypair.export()), 'identity.signing-key');
    await query('INSERT INTO reserved_signing_keys (signing_key, key_bytes) VALUES ($1, $2)', [keypair.did(), encrypted]);
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
