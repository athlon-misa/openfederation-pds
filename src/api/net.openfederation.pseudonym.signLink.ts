import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { parseLinkStatement, base64UrlEncode } from '../../packages/openfederation-pseudonym/src/formats.js';

/**
 * The owner's half of a pseudonym link, signed with the caller's repo key.
 * Root keys are custodial today, so this PDS sees the link at signing time
 * (documented limit). It stores, logs and audits nothing about it.
 */
export default async function signLink(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  // External service-auth callers have no local signing key on this PDS.
  if (req.auth.authMethod === 'service-auth') {
    res.status(403).json({ error: 'Forbidden', message: 'Local account required' });
    return;
  }
  const statement = typeof req.body?.statement === 'string' ? req.body.statement : '';
  const parsed = parseLinkStatement(statement);
  if (!parsed) {
    res.status(400).json({ error: 'InvalidStatement', message: 'Not a canonical pseudonym link statement' });
    return;
  }
  try {
    const caller = (await query<{ auth_type: string }>('SELECT auth_type FROM users WHERE id = $1', [req.auth.userId])).rows[0];
    if (parsed.ownerDid !== req.auth.did || !caller || caller.auth_type === 'pseudonym' || caller.auth_type === 'external') {
      res.status(403).json({ error: 'Forbidden', message: 'You can only sign links that name your own account as owner' });
      return;
    }
    const keypair = await getKeypairForDid(req.auth.did);
    const sig = base64UrlEncode(await keypair.sign(new TextEncoder().encode(statement)));
    res.status(200).json({ ownerDid: req.auth.did, sig, signingKey: keypair.did() });
  } catch (error) {
    console.error('Error in pseudonym.signLink');
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to sign link' });
  }
}
