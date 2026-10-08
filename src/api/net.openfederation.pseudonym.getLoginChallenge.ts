import crypto from 'crypto';
import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { config } from '../config.js';

/** Always issues a challenge, so it cannot reveal which keys have accounts here. */
export default async function getLoginChallenge(req: Request, res: Response): Promise<void> {
  const ownerKey = typeof req.body?.ownerKey === 'string' ? req.body.ownerKey : '';
  if (!/^did:key:zQ3s[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(ownerKey)) {
    res.status(400).json({ error: 'InvalidRequest', message: 'ownerKey must be a secp256k1 did:key' });
    return;
  }
  try {
    const challengeId = crypto.randomUUID();
    const challenge = crypto.randomBytes(32).toString('hex');
    // Expiry on the DB clock, the same clock createSession checks against.
    await query(`INSERT INTO pseudonym_login_challenges (id, owner_key, challenge, expires_at)
                 VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')`,
      [challengeId, ownerKey, challenge]);
    await query('DELETE FROM pseudonym_login_challenges WHERE expires_at < NOW()');
    res.status(200).json({ challengeId, challenge, serviceDid: config.pds.serviceDid });
  } catch (error) {
    console.error('Error in pseudonym.getLoginChallenge');
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to issue challenge' });
  }
}
