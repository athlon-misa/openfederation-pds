import { Request, Response } from 'express';
import crypto from 'crypto';
import { withTransaction } from '../db/client.js';
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

    // Validate password strength
    if (!isStrongPassword(newPassword)) {
      res.status(400).json({
        error: 'WeakPassword',
        message: passwordValidationMessage(),
      });
      return;
    }

    const newHash = await hashPassword(newPassword);
    const completed = await withTransaction(async (client) => {
      const attemptResult = await client.query<{ id: string; user_did: string; tier: number }>(
        `SELECT id, user_did, tier FROM recovery_attempts
         WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()
         FOR UPDATE`,
        [tokenHash],
      );
      if (attemptResult.rows.length === 0) return null;
      const attempt = attemptResult.rows[0];
      const userResult = await client.query<{ id: string; handle: string; email: string }>(
        'SELECT id, handle, email FROM users WHERE did = $1 FOR UPDATE',
        [attempt.user_did],
      );
      if (userResult.rows.length === 0) return null;
      const user = userResult.rows[0];
      await client.query('UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL, token_version = token_version + 1 WHERE id = $2', [newHash, user.id]);
      await client.query(`UPDATE recovery_attempts SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [attempt.id]);
      const sessions = await client.query(`UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
      return { attempt, user, sessionsRevoked: sessions.rowCount || 0 };
    });

    if (!completed) {
      res.status(400).json({
        error: 'InvalidToken',
        message: 'Recovery token is invalid, expired, or already used.',
      });
      return;
    }

    // Send notification email
    await sendEmail(
      completed.user.email,
      'Password Changed — OpenFederation',
      passwordChangedEmail(completed.user.handle),
      'recovery-complete',
    );

    await auditLog('account.recovery.complete', null, completed.user.id, {
      tier: completed.attempt.tier,
      sessionsRevoked: completed.sessionsRevoked,
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
