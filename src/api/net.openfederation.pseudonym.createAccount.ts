import crypto from 'crypto';
import { Request, Response } from 'express';
import { withTransaction } from '../db/client.js';
import { config } from '../config.js';
import { getPlcLog } from '../identity/plc-client.js';
import { checkPseudonymGenesis } from '../identity/pseudonym/genesis.js';
import { redeemToken } from '../identity/pseudonym/tokens.js';
import { consumeReservedSigningKey } from './com.atproto.server.reserveSigningKey.js';
import { insertUserWithRole } from '../auth/account-creation.js';
import { isValidHandle } from '../auth/utils.js';
import { encryptKeyBytes } from '../auth/encryption.js';
import { Secp256k1Keypair } from '@atproto/crypto';
import { RepoEngine } from '../repo/repo-engine.js';

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/**
 * Host a pseudonym whose genesis op the client already put in PLC. The
 * caller is anonymous and proves eligibility with a blind creation token,
 * so this PDS cannot tell which account it belongs to. No audit, by design.
 */
export default async function createPseudonymAccount(req: Request, res: Response): Promise<void> {
  const did = typeof req.body?.did === 'string' ? req.body.did : '';
  const token = req.body?.token;
  if (!/^did:plc:[a-z2-7]{24}$/.test(did)) {
    res.status(400).json({ error: 'InvalidRequest', message: 'did must be a did:plc' });
    return;
  }
  if (!token || typeof token !== 'object') {
    res.status(400).json({ error: 'InvalidToken', message: 'A creation token is required' });
    return;
  }
  try {
    const log = await getPlcLog(did);
    if (!log || log.length !== 1) throw new Refusal(400, 'InvalidGenesis', 'DID must exist with exactly its genesis operation');
    const check = await checkPseudonymGenesis(did, log[0], { serviceUrl: config.pds.serviceUrl, handleSuffix: config.handleSuffix });
    if (!check.ok) throw new Refusal(400, 'InvalidGenesis', check.reason);

    // Accounts store the bare label; the genesis op carries label + suffix.
    const label = check.handle.slice(0, -config.handleSuffix.length);
    if (!isValidHandle(label)) throw new Refusal(400, 'InvalidGenesis', 'BadHandle');

    const keyBytes = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM users WHERE did = $1 OR handle = $2
         UNION ALL SELECT 1 FROM communities WHERE handle = $2`, [did, label]);
      if (existing.rows.length > 0) throw new Refusal(409, 'AlreadyExists', 'Account already exists');
      const redeemed = await redeemToken(client, token);
      if (redeemed === 'invalid') throw new Refusal(400, 'InvalidToken', 'Creation token is not valid');
      if (redeemed === 'spent') throw new Refusal(400, 'TokenSpent', 'Creation token was already used');
      const bytes = await consumeReservedSigningKey(client, check.signingKey);
      if (!bytes) throw new Refusal(400, 'SigningKeyNotReserved', 'Signing key was not reserved here');
      await insertUserWithRole(client, {
        userId: crypto.randomUUID(), handle: label, email: null, passwordHash: null,
        did, status: 'approved', authType: 'pseudonym', pseudonymOwnerKey: check.ownerKey,
      });
      // Stored in the same transaction: token spend, key consumption, user
      // row and signing key commit or roll back together.
      const encrypted = await encryptKeyBytes(bytes, 'identity.signing-key');
      await client.query('INSERT INTO user_signing_keys (user_did, signing_key_bytes) VALUES ($1, $2)', [did, encrypted]);
      return bytes;
    });
    // Best-effort; failures are logged without the DID or handle.
    try {
      const keypair = await Secp256k1Keypair.import(keyBytes, { exportable: false });
      await new RepoEngine(did).createRepo(keypair, [
        { collection: 'app.bsky.actor.profile', rkey: 'self', record: { displayName: label, description: '' } },
      ]);
    } catch {
      console.error('Warning: failed to initialize pseudonym repo (account still created)');
    }
    res.status(201).json({ did, handle: check.handle, status: 'approved' });
  } catch (error) {
    if (error instanceof Refusal) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in pseudonym.createAccount');
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create pseudonym account' });
  }
}
