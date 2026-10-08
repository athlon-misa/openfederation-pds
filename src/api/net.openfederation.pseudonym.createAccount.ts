import crypto from 'crypto';
import { Request, Response } from 'express';
import { withTransaction } from '../db/client.js';
import { config } from '../config.js';
import { getPlcLog } from '../identity/plc-client.js';
import { checkPseudonymGenesis } from '../identity/pseudonym/genesis.js';
import { redeemToken } from '../identity/pseudonym/tokens.js';
import { consumeReservedSigningKey } from './com.atproto.server.reserveSigningKey.js';
import { insertUserWithRole, initializeUserRepoAsync } from '../auth/account-creation.js';

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

    const keyBytes = await withTransaction(async (client) => {
      const existing = await client.query('SELECT 1 FROM users WHERE did = $1 OR handle = $2', [did, check.handle]);
      if (existing.rows.length > 0) throw new Refusal(409, 'AlreadyExists', 'Account already exists');
      const redeemed = await redeemToken(client, token);
      if (redeemed === 'invalid') throw new Refusal(400, 'InvalidToken', 'Creation token is not valid');
      if (redeemed === 'spent') throw new Refusal(400, 'TokenSpent', 'Creation token was already used');
      const bytes = await consumeReservedSigningKey(client, check.signingKey);
      if (!bytes) throw new Refusal(400, 'SigningKeyNotReserved', 'Signing key was not reserved here');
      await insertUserWithRole(client, {
        userId: crypto.randomUUID(), handle: check.handle, email: null, passwordHash: null,
        did, status: 'approved', authType: 'pseudonym', pseudonymOwnerKey: check.ownerKey,
      });
      return bytes;
    });
    await initializeUserRepoAsync(did, check.handle, keyBytes.toString('base64'));
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
