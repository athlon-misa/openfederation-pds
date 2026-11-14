import { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { Secp256k1Keypair } from '@atproto/crypto';
import { query } from '../db/client.js';
import { runtimeSettings } from '../settings/runtime-settings.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';

const MAX_RESERVATIONS = 10_000;

/**
 * net.openfederation.account.reserveCustodyKey (ADR-003, decision 4)
 *
 * Makes the rotation key this PDS will hold for an `assisted` account and
 * returns its did:key. The client lists it second in the genesis operation,
 * after the user's own key; registerSelfCustody then takes the reservation
 * and keeps the key as vault shares 2 and 3. Unauthenticated (the account
 * does not exist yet) and rate limited; rows carry no timestamp and the table
 * is capped FIFO, like reserveSigningKey.
 */
export default async function reserveCustodyKey(_req: Request, res: Response): Promise<void> {
  if (!runtimeSettings().identity.custodyAllowed.includes('assisted')) {
    res.status(403).json({ error: 'CustodyModeNotAllowed', message: 'This server does not allow assisted accounts' });
    return;
  }
  try {
    const keypair = await Secp256k1Keypair.create({ exportable: true });
    const bytes = Buffer.from(await keypair.export());
    await query('INSERT INTO reserved_rotation_keys (rotation_key, key_bytes) VALUES ($1, $2)',
      [keypair.did(), await encryptKeyBytes(bytes, 'identity.recovery-key')]);
    bytes.fill(0);
    await query(
      `DELETE FROM reserved_rotation_keys WHERE seq IN (
         SELECT seq FROM reserved_rotation_keys ORDER BY seq DESC OFFSET $1)`, [MAX_RESERVATIONS]);
    res.status(200).json({ rotationKey: keypair.did() });
  } catch (error) {
    console.error('Error in reserveCustodyKey:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to reserve a rotation key' });
  }
}

/** Atomically take a reservation; null when unknown or already used. */
export async function consumeReservedRotationKey(client: PoolClient, rotationKey: string): Promise<Buffer | null> {
  const row = await client.query<{ key_bytes: Buffer }>(
    'DELETE FROM reserved_rotation_keys WHERE rotation_key = $1 RETURNING key_bytes', [rotationKey]);
  if (row.rows.length === 0) return null;
  return decryptKeyBytes(row.rows[0].key_bytes, 'identity.recovery-key');
}
