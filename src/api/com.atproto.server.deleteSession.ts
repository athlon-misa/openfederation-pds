import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { hashToken } from '../auth/tokens.js';
import { auditLog } from '../db/audit.js';
import type { AuthRequest } from '../auth/types.js';

/**
 * com.atproto.server.deleteSession
 *
 * Logout / revoke the current session's refresh token. AT Protocol clients
 * send the refresh token as the bearer token, with no body; this server's
 * own clients send it as `refreshJwt` in the body (with the access token as
 * the bearer). The body wins when both are there, as in refreshSession.
 */
export default async function deleteSession(req: AuthRequest, res: Response): Promise<void> {
  try {
    const header = req.headers.authorization;
    const headerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const refreshToken = (typeof req.body?.refreshJwt === 'string' && req.body.refreshJwt) || headerToken;

    if (!refreshToken) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'refreshJwt is required',
      });
      return;
    }

    const tokenHash = hashToken(refreshToken);

    const result = await query<{ user_id: string }>(
      `UPDATE sessions
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE refresh_token_hash = $1 AND revoked_at IS NULL
       RETURNING user_id`,
      [tokenHash]
    );

    if (result.rowCount === 0) {
      // Token not found or already revoked - still return success (idempotent)
      res.status(200).json({ success: true });
      return;
    }

    const userId = result.rows[0].user_id;
    await query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId]);
    await auditLog('session.delete', userId, userId);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to delete session',
    });
  }
}
