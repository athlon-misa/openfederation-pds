import crypto from 'crypto';
import { query } from '../../src/db/client.js';
import { uniqueHandle } from './helpers.js';
import { config } from '../../src/config.js';

/** A pseudonym account row, inserted directly (no PLC). For privacy-path tests. */
export async function insertPseudonymUser(): Promise<{ id: string; did: string; handle: string }> {
  const id = crypto.randomUUID();
  const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
  const did = `did:plc:${Array.from(crypto.randomBytes(24), (b) => B32[b % 32]).join('')}`;
  const handle = `${uniqueHandle('ps')}${config.handleSuffix}`;
  await query(
    `INSERT INTO users (id, handle, email, password_hash, status, did, auth_type, pseudonym_owner_key)
     VALUES ($1, $2, NULL, NULL, 'approved', $3, 'pseudonym', $4)`,
    [id, handle, did, `did:key:zQ3s${crypto.randomBytes(20).toString('hex')}`],
  );
  await query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'user')`, [id]);
  return { id, did, handle };
}
