import { Response } from 'express';
import { query } from '../db/client.js';
import { requireAuth } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { sendEmail } from '../email/email-service.js';
import { sessionsRevokedEmail } from '../email/templates.js';
import type { AuthRequest } from '../auth/types.js';

export default async function revokeSession(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  const { sessionId, revokeAll, did } = req.body || {};

  if (!sessionId && !revokeAll) {
    res.status(400).json({ error: 'InvalidRequest', message: 'Provide sessionId or set revokeAll to true.' });
    return;
  }

  // Admin can revoke another user's sessions
  let targetUserId = req.auth.userId;
  let targetHandle = req.auth.handle;
  let targetEmail: string | null = req.auth.email || null;

  if (did && did !== req.auth.did) {
    if (!req.auth.roles.includes('admin')) {
      res.status(403).json({ error: 'Forbidden', message: "Only admins can revoke other users' sessions." });
      return;
    }
    const userResult = await query<{ id: string; handle: string; email: string }>(
      'SELECT id, handle, email FROM users WHERE did = $1',
      [did]
    );
    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'User not found.' });
      return;
    }
    targetUserId = userResult.rows[0].id;
    targetHandle = userResult.rows[0].handle;
    targetEmail = userResult.rows[0].email;
  }

  let result;
  if (revokeAll) {
    // Revoke all sessions — user will need to re-login
    result = await query(
      `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [targetUserId]
    );
  } else {
    // Revoke specific session by ID prefix
    result = await query(
      `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND id LIKE $2 AND revoked_at IS NULL`,
      [targetUserId, `${sessionId}%`]
    );
    if ((result.rowCount ?? 0) === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Session not found or already revoked.' });
      return;
    }
  }

  const revokedCount = result.rowCount ?? 0;

  await auditLog('session.revoke', req.auth.userId, targetUserId, {
    revokedCount,
    revokeAll: !!revokeAll,
    sessionIdPrefix: sessionId || null,
  });

  // Send email notification
  if (targetEmail && revokedCount > 0) {
    await sendEmail(
      targetEmail,
      'Sessions Revoked — OpenFederation',
      sessionsRevokedEmail(targetHandle, revokedCount)
    );
  }

  res.status(200).json({ revokedCount });
}
