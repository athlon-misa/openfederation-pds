import { Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db/client.js';
import { normalizeEmail, normalizeHandle } from '../auth/utils.js';
import { auditLog } from '../db/audit.js';
import { sendEmail } from '../email/email-service.js';
import { passwordResetEmail } from '../email/templates.js';
import { config } from '../config.js';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export default async function requestPasswordReset(req: Request, res: Response): Promise<void> {
  try {
    const { identifier } = req.body || {};
    if (!identifier) {
      // Always return success to avoid leaking info
      res.status(200).json({ success: true });
      return;
    }

    const normalized = identifier.includes('@')
      ? normalizeEmail(identifier)
      : normalizeHandle(identifier);

    const userResult = await query<{ id: string; handle: string; email: string; auth_type: string }>(
      'SELECT id, handle, email, auth_type FROM users WHERE handle = $1 OR email = $1',
      [normalized]
    );

    // Always return success — don't leak whether user exists
    if (userResult.rows.length === 0 || userResult.rows[0].auth_type === 'external') {
      res.status(200).json({ success: true });
      return;
    }

    const user = userResult.rows[0];

    // Generate token
    const token = crypto.randomBytes(48).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    // Invalidate any existing reset tokens for this user
    await query(
      'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL',
      [user.id]
    );

    // Store new token
    await query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt.toISOString()]
    );

    // Build reset URL
    const baseUrl = config.pds.serviceUrl || `http://localhost:${config.port}`;
    const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;

    // Send email
    await sendEmail(
      user.email,
      'Password Reset — OpenFederation',
      passwordResetEmail(user.handle, resetUrl, 60)
    );

    await auditLog('account.password.reset.request', null, user.id, {
      email: user.email,
      ip: req.ip,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error requesting password reset:', error);
    // Still return success to avoid leaking info via error responses
    res.status(200).json({ success: true });
  }
}
