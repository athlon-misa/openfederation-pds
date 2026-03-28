import { Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { isStrongPassword, passwordValidationMessage } from '../auth/utils.js';
import { auditLog } from '../db/audit.js';
import { sendEmail } from '../email/email-service.js';
import { passwordChangedEmail } from '../email/templates.js';

export default async function confirmPasswordReset(req: Request, res: Response): Promise<void> {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      res.status(400).json({ error: 'InvalidRequest', message: 'token and newPassword are required.' });
      return;
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find valid, unused, non-expired token
    const tokenResult = await query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );

    if (tokenResult.rows.length === 0) {
      res.status(400).json({ error: 'InvalidToken', message: 'Token is invalid, expired, or already used.' });
      return;
    }

    const resetToken = tokenResult.rows[0];

    // Validate password strength
    if (!isStrongPassword(newPassword)) {
      res.status(400).json({ error: 'WeakPassword', message: passwordValidationMessage() });
      return;
    }

    // Update password
    const newHash = await hashPassword(newPassword);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, resetToken.user_id]);

    // Mark token as used
    await query('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [resetToken.id]);

    // Revoke all sessions
    const sessionResult = await query(
      'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL',
      [resetToken.user_id]
    );

    // Reset failed login counter
    await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [resetToken.user_id]);

    // Get user info for email and audit
    const userResult = await query<{ handle: string; email: string }>(
      'SELECT handle, email FROM users WHERE id = $1', [resetToken.user_id]
    );

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      await sendEmail(user.email, 'Password Changed — OpenFederation', passwordChangedEmail(user.handle));

      await auditLog('account.password.reset.confirm', null, resetToken.user_id, {
        sessionsRevoked: sessionResult.rowCount || 0,
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error confirming password reset:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to reset password.' });
  }
}
