import { Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { isStrongPassword, passwordValidationMessage } from '../auth/utils.js';
import { auditLog } from '../db/audit.js';
import { sendEmail } from '../email/email-service.js';
import { passwordChangedEmail } from '../email/templates.js';

export default async function completeRecovery(req: Request, res: Response): Promise<void> {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'token and newPassword are required.',
      });
      return;
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find valid, pending, non-expired recovery attempt
    const attemptResult = await query<{
      id: string;
      user_did: string;
      tier: number;
    }>(
      `SELECT id, user_did, tier FROM recovery_attempts
       WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()`,
      [tokenHash]
    );

    if (attemptResult.rows.length === 0) {
      res.status(400).json({
        error: 'InvalidToken',
        message: 'Recovery token is invalid, expired, or already used.',
      });
      return;
    }

    const attempt = attemptResult.rows[0];

    // Validate password strength
    if (!isStrongPassword(newPassword)) {
      res.status(400).json({
        error: 'WeakPassword',
        message: passwordValidationMessage(),
      });
      return;
    }

    // Look up user by DID
    const userResult = await query<{ id: string; handle: string; email: string }>(
      'SELECT id, handle, email FROM users WHERE did = $1',
      [attempt.user_did]
    );

    if (userResult.rows.length === 0) {
      res.status(400).json({
        error: 'InvalidToken',
        message: 'Recovery token is invalid, expired, or already used.',
      });
      return;
    }

    const user = userResult.rows[0];

    // Update password
    const newHash = await hashPassword(newPassword);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

    // Mark recovery attempt as completed
    await query(
      `UPDATE recovery_attempts SET status = 'completed', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [attempt.id]
    );

    // Revoke all existing sessions
    const sessionResult = await query(
      `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id]
    );

    // Reset failed login counter
    await query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
      [user.id]
    );

    // Send notification email
    await sendEmail(
      user.email,
      'Password Changed — OpenFederation',
      passwordChangedEmail(user.handle)
    );

    await auditLog('account.recovery.complete', null, user.id, {
      tier: attempt.tier,
      sessionsRevoked: sessionResult.rowCount || 0,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error completing recovery:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to complete recovery.',
    });
  }
}
