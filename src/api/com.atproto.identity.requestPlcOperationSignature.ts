import crypto from 'crypto';
import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { sendEmail } from '../email/email-service.js';
import { holdsRotationKey } from '../identity/plc-ops.js';

const TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * AT Protocol requestPlcOperationSignature (#266): emails a one-time code
 * the user quotes to signPlcOperation. Only for accounts whose rotation key
 * this PDS holds in custody; a pseudonym signs with its own key and never
 * reaches this endpoint.
 */
export default async function requestPlcOperationSignature(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (req.auth.authMethod === 'service-auth') {
    res.status(403).json({ error: 'Forbidden', message: 'Log in to the account to change its identity' });
    return;
  }
  try {
    const user = (await query<{ id: string; handle: string; email: string | null; auth_type: string }>(
      'SELECT id, handle, email, auth_type FROM users WHERE id = $1', [req.auth.userId])).rows[0];
    if (!user || user.auth_type !== 'local' || !(await holdsRotationKey(req.auth.did))) {
      res.status(400).json({ error: 'NotCustodial', message: 'This PDS holds no rotation key for this account' });
      return;
    }
    if (!user.email) {
      res.status(400).json({ error: 'NoEmail', message: 'This account has no email address.' });
      return;
    }

    const code = crypto.randomBytes(5).toString('hex').toUpperCase().replace(/^(.{5})(.{5})$/, '$1-$2');
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    await query('UPDATE plc_operation_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await query('INSERT INTO plc_operation_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, hash, new Date(Date.now() + TOKEN_TTL_MS).toISOString()]);

    const delivery = await sendEmail(user.email, 'Confirm your identity change — OpenFederation',
      `<p>Hi ${user.handle},</p><p>Someone asked to change where your account lives (for example to move it to another server). If that was you, enter this code in the app:</p><p style="font-size:1.4em;font-family:monospace">${code}</p><p>The code works once and expires in 15 minutes. If this was not you, ignore this email and change your password.</p>`,
      'other');
    await auditLog('identity.plcSignature.request', user.id, user.id, { did: req.auth.did, delivery: delivery.outcome });
    if (delivery.outcome !== 'sent' && delivery.outcome !== 'not-configured') {
      res.status(502).json({ error: 'EmailDeliveryFailed', message: `The code could not be sent (${delivery.outcome}).` });
      return;
    }
    res.status(200).json({});
  } catch (error) {
    console.error('Error in requestPlcOperationSignature:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to request a signature code' });
  }
}
