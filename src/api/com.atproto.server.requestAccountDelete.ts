import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { sendEmail } from '../email/email-service.js';
import { accountDeleteCodeEmail } from '../email/templates.js';
import { DELETE_CODE_TTL_MS, hashDeleteCode, newDeleteCode } from '../identity/owner-delete.js';

/**
 * com.atproto.server.requestAccountDelete
 *
 * Emails the signed-in user a code for com.atproto.server.deleteAccount.
 * Reachable with the limited session of a deactivated account, so the copy a
 * move left behind can be removed. A new request replaces any earlier code.
 * Pseudonyms have no email: they prove deletion with their owner key instead.
 */
export default async function requestAccountDelete(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (req.auth.authMethod === 'service-auth') {
      res.status(403).json({ error: 'Forbidden', message: 'Request deletion from your own session on this server' });
      return;
    }
    const user = (await query<{ id: string; handle: string; email: string | null }>(
      'SELECT id, handle, email FROM users WHERE did = $1', [req.auth.did])).rows[0];
    if (!user?.email) {
      res.status(400).json({ error: 'InvalidRequest', message: 'This account has no email; a pseudonym deletes itself with its owner key' });
      return;
    }
    const code = newDeleteCode();
    await query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND purpose = 'account-delete' AND used_at IS NULL`, [user.id]);
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, purpose) VALUES ($1, $2, $3, 'account-delete')`,
      [user.id, hashDeleteCode(code), new Date(Date.now() + DELETE_CODE_TTL_MS)]);
    await sendEmail(user.email, 'Confirm account deletion — OpenFederation',
      accountDeleteCodeEmail(user.handle, code, DELETE_CODE_TTL_MS / 60000), 'account-delete');
    res.status(200).json({});
  } catch (error) {
    console.error('Error in requestAccountDelete:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to request account deletion' });
  }
}
