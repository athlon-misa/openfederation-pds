import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { query, withTransaction } from '../db/client.js';
import { config } from '../config.js';
import { blindSignBatch, InvalidBlindedMessageError } from '../identity/pseudonym/tokens.js';
import { currentEpoch } from '../../packages/openfederation-pseudonym/src/formats.js';

/**
 * Hand an approved regular account its batch of blind creation tokens for
 * the current epoch. Clients call this on a fixed schedule whether or not
 * they need tokens, so a call reveals nothing. Stores one flag; no audit.
 */
export default async function collectTokens(req: AuthRequest, res: Response): Promise<void> {
  if (!requireApprovedUser(req, res)) return;
  const epoch = req.body?.epoch;
  const blinded = req.body?.blindedMessages;
  if (epoch !== currentEpoch()) {
    res.status(400).json({ error: 'WrongEpoch', message: `Tokens are issued for ${currentEpoch()} only` });
    return;
  }
  if (!Array.isArray(blinded) || blinded.length !== config.pseudonym.tokensPerEpoch
    || !blinded.every((b) => typeof b === 'string' && /^[A-Za-z0-9_-]{342}$/.test(b))) {
    res.status(400).json({ error: 'InvalidRequest', message: `blindedMessages must be ${config.pseudonym.tokensPerEpoch} base64url strings` });
    return;
  }
  if (req.auth!.authMethod === 'service-auth') {
    res.status(403).json({ error: 'Forbidden', message: 'Only local accounts can collect creation tokens' });
    return;
  }
  try {
    const u = await query<{ auth_type: string }>('SELECT auth_type FROM users WHERE id = $1', [req.auth!.userId]);
    if (u.rows[0]?.auth_type !== 'local') {
      res.status(403).json({ error: 'Forbidden', message: 'Only local accounts can collect creation tokens' });
      return;
    }
    // Claim and sign in one transaction: any failure rolls the claim back.
    const signatures = await withTransaction(async (tx) => {
      const claimed = await tx.query(
        'INSERT INTO pseudonym_token_batches (user_id, epoch) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.auth!.userId, epoch]);
      if (claimed.rowCount !== 1) return null;
      return blindSignBatch(epoch, blinded);
    });
    if (!signatures) {
      res.status(409).json({ error: 'AlreadyCollected', message: 'This epoch\'s tokens were already collected' });
      return;
    }
    res.status(200).json({ epoch, blindSignatures: signatures });
  } catch (error) {
    if (error instanceof InvalidBlindedMessageError) {
      res.status(400).json({ error: 'InvalidRequest', message: 'blindedMessages contains an invalid blinded message' });
      return;
    }
    console.error('Error in pseudonym.collectTokens:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to issue tokens' });
  }
}
