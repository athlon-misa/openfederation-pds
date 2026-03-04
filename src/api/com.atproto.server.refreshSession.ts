import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { generateRefreshToken, hashToken, refreshTtlMs, signAccessToken } from '../auth/tokens.js';
import { auditLog } from '../db/audit.js';
import type { UserRole, UserStatus } from '../auth/types.js';

interface RefreshSessionInput {
  refreshJwt?: string;
}

export default async function refreshSession(req: Request, res: Response): Promise<void> {
  try {
    const input: RefreshSessionInput = req.body || {};
    const authHeader = req.headers.authorization;
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
    const refreshToken = input.refreshJwt || headerToken;

    if (!refreshToken) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'refreshJwt is required',
      });
      return;
    }

    const tokenHash = hashToken(refreshToken);
    const sessionResult = await query<{
      id: string;
      user_id: string;
      expires_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, user_id, expires_at, revoked_at
       FROM sessions
       WHERE refresh_token_hash = $1`,
      [tokenHash]
    );

    if (sessionResult.rows.length === 0) {
      // Token not found: could be a reused (already-rotated) token.
      // Check if this hash appears in the previous_token_hash column.
      const reuseCheck = await query<{ user_id: string }>(
        `SELECT user_id FROM sessions WHERE previous_token_hash = $1`,
        [tokenHash]
      );

      if (reuseCheck.rows.length > 0) {
        // Token reuse detected! Revoke all sessions for this user as a precaution.
        const compromisedUserId = reuseCheck.rows[0].user_id;
        await query(
          `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [compromisedUserId]
        );
        console.error(`SECURITY: Refresh token reuse detected for user ${compromisedUserId}. All sessions revoked.`);
      }

      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid refresh token',
      });
      return;
    }

    const session = sessionResult.rows[0];
    if (session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Refresh token expired or revoked',
      });
      return;
    }

    const userResult = await query<{
      id: string;
      handle: string;
      email: string;
      status: string;
      did: string;
    }>('SELECT id, handle, email, status, did FROM users WHERE id = $1', [session.user_id]);

    if (userResult.rows.length === 0) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User not found',
      });
      return;
    }

    const user = userResult.rows[0];
    if (user.status === 'suspended') {
      res.status(403).json({
        error: 'AccountSuspended',
        message: 'Your account has been suspended.',
      });
      return;
    }

    if (user.status === 'takendown') {
      res.status(410).json({
        error: 'AccountTakenDown',
        message: 'Your account has been taken down.',
      });
      return;
    }

    if (user.status === 'deactivated') {
      res.status(403).json({
        error: 'AccountDeactivated',
        message: 'Your account is deactivated. Reactivate it to continue.',
      });
      return;
    }

    if (user.status !== 'approved') {
      res.status(403).json({
        error: 'AccountNotApproved',
        message: 'Your account must be approved before refreshing session.',
      });
      return;
    }

    // Re-fetch roles from DB (ensures revoked roles take effect immediately)
    const rolesResult = await query<{ role: UserRole }>(
      'SELECT role FROM user_roles WHERE user_id = $1',
      [user.id]
    );
    const roles = rolesResult.rows.map((row) => row.role);

    const accessJwt = signAccessToken({
      userId: user.id,
      handle: user.handle,
      email: user.email,
      did: user.did,
      status: user.status as UserStatus,
      roles,
    });

    const { token: newRefreshJwt, hash: newHash } = generateRefreshToken();
    const newExpiresAt = new Date(Date.now() + refreshTtlMs());

    // Rotate token: store old hash for reuse detection, update to new hash
    await query(
      `UPDATE sessions
       SET refresh_token_hash = $1,
           previous_token_hash = $4,
           expires_at = $2,
           last_used_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [newHash, newExpiresAt.toISOString(), session.id, tokenHash]
    );

    await auditLog('session.refresh', user.id, user.id);

    res.status(200).json({
      did: user.did,
      handle: user.handle,
      email: user.email,
      accessJwt,
      refreshJwt: newRefreshJwt,
      active: true,
    });
  } catch (error) {
    console.error('Error refreshing session:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to refresh session',
    });
  }
}
