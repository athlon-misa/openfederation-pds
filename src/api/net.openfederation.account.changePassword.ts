import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { verifyPassword, hashPassword } from '../auth/password.js';
import { isStrongPassword, passwordValidationMessage } from '../auth/utils.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { revokeOAuthGrants } from '../auth/revoke-grants.js';
import { checkPasswordWithLockout } from '../auth/password-check.js';

interface ChangePasswordInput {
  currentPassword?: string;
  newPassword?: string;
}

export default async function changePassword(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) {
    return;
  }

  const input: ChangePasswordInput = req.body || {};
  const currentPassword = input.currentPassword?.trim();
  const newPassword = input.newPassword;

  if (!currentPassword || !newPassword) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'currentPassword and newPassword are required',
    });
    return;
  }

  // Reject external auth users (they don't have a local password)
  const userResult = await query<{ auth_type: string; password_hash: string | null }>(
    'SELECT auth_type, password_hash FROM users WHERE id = $1',
    [req.auth.userId]
  );

  if (userResult.rows.length === 0) {
    res.status(404).json({
      error: 'NotFound',
      message: 'User not found',
    });
    return;
  }

  const user = userResult.rows[0];

  if (user.auth_type !== 'local') {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'This account type cannot change password',
    });
    return;
  }

  if (!user.password_hash) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'Account does not have a password set',
    });
    return;
  }

  // Verify current password
  const check = await checkPasswordWithLockout(req.auth.userId, user.password_hash, currentPassword);
  if (!check.ok && check.reason === 'locked') {
    res.status(429).json({
      error: 'AccountLocked',
      message: `Too many failed attempts. Try again in ${check.retryAfterSeconds} seconds.`,
    });
    return;
  }
  if (!check.ok) {
    res.status(400).json({
      error: 'InvalidPassword',
      message: 'Current password is incorrect',
    });
    return;
  }

  // Validate new password strength
  if (!isStrongPassword(newPassword)) {
    res.status(400).json({
      error: 'WeakPassword',
      message: passwordValidationMessage(),
    });
    return;
  }

  // Hash and update
  const newHash = await hashPassword(newPassword);

  await query(
    'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
    [newHash, req.auth.userId]
  );

  // Invalidate all existing sessions (force re-login)
  await query('DELETE FROM sessions WHERE user_id = $1', [req.auth.userId]);
  // ...and every client authorised through OAuth, and any reset link still in the post.
  await revokeOAuthGrants(req.auth.did);
  await query(
    `UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND purpose = 'password-reset' AND used_at IS NULL`,
    [req.auth.userId],
  );

  // Audit log
  await auditLog('account.password.change', req.auth.userId, req.auth.userId, {
    handle: req.auth.handle,
  });

  res.status(200).json({ success: true });
}
