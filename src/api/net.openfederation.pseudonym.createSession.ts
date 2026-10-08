import { Request, Response } from 'express';
import { verifySignature } from '@atproto/crypto';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { issueSession } from '../auth/session-issue.js';
import { buildLoginMessage, base64UrlDecode } from '../../packages/openfederation-pseudonym/src/formats.js';

const UNAUTHORIZED = { error: 'Unauthorized', message: 'Invalid credentials' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Phrase login, second half. No audit, by design. */
export default async function createPseudonymSession(req: Request, res: Response): Promise<void> {
  const challengeId = typeof req.body?.challengeId === 'string' ? req.body.challengeId : '';
  const signature = typeof req.body?.signature === 'string' ? req.body.signature : '';
  if (!UUID.test(challengeId) || !signature) { res.status(401).json(UNAUTHORIZED); return; }
  try {
    // Single use: deleted whether or not the signature is good.
    const consumed = await query<{ owner_key: string; challenge: string }>(
      'DELETE FROM pseudonym_login_challenges WHERE id = $1 AND expires_at > NOW() RETURNING owner_key, challenge', [challengeId]);
    if (consumed.rows.length === 0) { res.status(401).json(UNAUTHORIZED); return; }
    const { owner_key: ownerKey, challenge } = consumed.rows[0];

    let ok = false;
    try {
      ok = await verifySignature(ownerKey, new TextEncoder().encode(buildLoginMessage({ serviceDid: config.pds.serviceDid, challenge })), base64UrlDecode(signature));
    } catch { ok = false; }
    if (!ok) { res.status(401).json(UNAUTHORIZED); return; }

    const user = (await query<{ id: string; handle: string; did: string; status: string; token_version: number }>(
      `SELECT id, handle, did, status, token_version FROM users WHERE pseudonym_owner_key = $1 AND auth_type = 'pseudonym'`, [ownerKey])).rows[0];
    if (!user) { res.status(401).json(UNAUTHORIZED); return; }
    if (user.status !== 'approved') { res.status(403).json({ error: 'AccountNotActive', message: 'This account is not active.' }); return; }

    const { accessJwt, refreshJwt } = await issueSession({ ...user, email: null });
    res.status(200).json({ did: user.did, handle: user.handle, accessJwt, refreshJwt, active: true });
  } catch (error) {
    console.error('Error in pseudonym.createSession');
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create session' });
  }
}
