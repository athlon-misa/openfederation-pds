import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { hashToken } from '../auth/tokens.js';
import { auditLog } from '../db/audit.js';
import type { AuthRequest } from '../auth/types.js';

/**
 * com.atproto.server.deleteSession
 *
 * Logout / revoke the current session's refresh token.
 */
export default async function deleteSession(req: AuthRequest, res: Response): Promise<void> {
  try {
    const refreshToken = req.body?.refreshJwt;

    if (!refreshToken) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'refreshJwt is required',
      });
      return;
    }

    const tokenHash = hashToken(refreshToken);

    const result = await query(
      `UPDATE sessions
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash]
    );

    if (result.rowCount === 0) {
      // Token not found or already revoked - still return success (idempotent)
      res.status(200).json({ success: true });
      return;
    }

    const userId = req.auth?.userId || null;
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
