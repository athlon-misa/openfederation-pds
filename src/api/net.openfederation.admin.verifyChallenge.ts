import { Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db/client.js';
import { requireAuth, requireRole } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import type { AuthRequest } from '../auth/types.js';

export default async function verifyChallenge(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req as AuthRequest, res)) return;
  if (!requireRole(req as AuthRequest, res, ['admin'])) return;

  const { did, nonce } = req.body || {};
  if (!did || !nonce) {
    res.status(400).json({ error: 'InvalidRequest', message: 'did and nonce are required.' });
    return;
  }

  const userResult = await query<{ id: string }>('SELECT id FROM users WHERE did = $1', [did]);
  if (userResult.rows.length === 0) {
    res.status(404).json({ error: 'NotFound', message: 'User not found.' });
    return;
  }

  const userId = userResult.rows[0].id;
  const nonceHash = crypto.createHash('sha256').update(`verify:${nonce}`).digest('hex');

  const tokenResult = await query(
    `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > NOW()`,
    [userId, nonceHash]
  );

  if (tokenResult.rowCount === 0) {
    await auditLog('admin.verification.failed', (req as AuthRequest).auth!.userId, userId, {
      targetDid: did,
    });
    res.status(400).json({ error: 'InvalidNonce', message: 'Nonce is invalid, expired, or already used.' });
    return;
  }

  await auditLog('admin.verification.success', (req as AuthRequest).auth!.userId, userId, {
    targetDid: did,
  });

  res.status(200).json({ verified: true, message: 'Identity verified. You may now proceed with the sensitive operation.' });
}
