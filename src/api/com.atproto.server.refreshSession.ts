import { Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { generateRefreshToken, hashToken, refreshTtlMs, signAccessToken } from '../auth/tokens.js';
import { auditLog } from '../db/audit.js';
import { pseudonymSessionExpiry } from '../auth/session-issue.js';
import type { UserRole, UserStatus } from '../auth/types.js';
import { revokeOAuthGrants } from '../auth/revoke-grants.js';
import { fullHandle } from '../auth/utils.js';

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

    let session: { id: string; user_id: string; expires_at: string; revoked_at: string | null };
    // True when the token is the one this session has only just rotated away
    // (a second tab, a retried request): the caller gets a session of its own
    // instead of rotating this one again.
    let withinGrace = false;

    if (sessionResult.rows.length > 0) {
      session = sessionResult.rows[0];
    } else {
      // Not a current token. If any session ever rotated it away, this is a
      // replay, however many rotations ago that was.
      const rotated = await findRotatedToken(tokenHash);
      if (!rotated) {
        res.status(401).json({ error: 'Unauthorized', message: 'Invalid refresh token' });
        return;
      }
      if (!rotated.benign) {
        await revokeAllSessionsForReuse(rotated.user_id);
        res.status(401).json({ error: 'Unauthorized', message: 'Invalid refresh token' });
        return;
      }
      session = rotated;
      withinGrace = true;
    }

    if (session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Refresh token expired or revoked',
      });
      return;
    }

    // Fetch user and roles in a single query
    const userResult = await query<{
      id: string;
      handle: string;
      email: string | null;
      status: string;
      did: string;
      token_version: number;
      auth_type: string;
      roles: string[];
    }>(
      `SELECT u.id, u.handle, u.email, u.status, u.did, u.token_version, u.auth_type,
              COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') as roles
       FROM users u
       LEFT JOIN user_roles r ON r.user_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [session.user_id]
    );

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

    // Deactivated accounts keep a limited session (#265).
    if (user.status !== 'approved' && user.status !== 'deactivated') {
      res.status(403).json({
        error: 'AccountNotApproved',
        message: 'Your account must be approved before refreshing session.',
      });
      return;
    }

    const roles = user.roles as UserRole[];

    const accessJwt = await signAccessToken({
      userId: user.id,
      handle: user.handle,
      email: user.email ?? '',
      did: user.did,
      status: user.status as UserStatus,
      roles,
      tokenVersion: user.token_version,
    });

    const { token: newRefreshJwt, hash: newHash } = generateRefreshToken();
    // Pseudonym sessions never record when they were used and only carry a
    // day-rounded expiry, so session timing cannot link a pseudonym to its owner.
    const isPseudonym = user.auth_type === 'pseudonym';
    const newExpiresAt = isPseudonym ? pseudonymSessionExpiry() : new Date(Date.now() + refreshTtlMs());

    if (!withinGrace) {
      // Rotate: the session takes the new token, and the old one joins the
      // list of tokens this session has rotated away, in one statement. The
      // conditional update is the exclusive claim: of two requests holding the
      // same token, only one rotates.
      const rotation = await query(
        `WITH rotated AS (
           UPDATE sessions
           SET refresh_token_hash = $1,
               previous_token_hash = $4,
               expires_at = $2,
               last_used_at = ${isPseudonym ? 'NULL' : 'CURRENT_TIMESTAMP'}
           WHERE id = $3
             AND refresh_token_hash = $4
             AND revoked_at IS NULL
           RETURNING id
         )
         INSERT INTO session_rotated_tokens (token_hash, session_id, rotated_at)
         SELECT $4, id, ${isPseudonym ? 'NULL' : 'CURRENT_TIMESTAMP'} FROM rotated
         ON CONFLICT (token_hash) DO NOTHING
         RETURNING session_id`,
        [newHash, newExpiresAt.toISOString(), session.id, tokenHash]
      );

      if (rotation.rowCount !== 1) {
        // Lost the race to a concurrent request with the same token. That
        // makes this token the one just rotated away; decide as for any other.
        const rotated = await findRotatedToken(tokenHash);
        if (!rotated?.benign) {
          if (rotated) await revokeAllSessionsForReuse(rotated.user_id);
          res.status(401).json({ error: 'Unauthorized', message: 'Invalid refresh token' });
          return;
        }
        withinGrace = true;
      }
    }

    if (withinGrace) {
      await query(
        `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at${isPseudonym ? ', created_at' : ''})
         VALUES ($1, $2, $3, $4${isPseudonym ? ', NULL' : ''})`,
        [crypto.randomUUID(), user.id, newHash, newExpiresAt.toISOString()]
      );
    }

    await auditLog('session.refresh', user.id, user.id);

    res.status(200).json({
      did: user.did,
      handle: fullHandle(user.handle),
      email: user.email ?? '',
      accessJwt,
      refreshJwt: newRefreshJwt,
      active: true,
      roles,
    });
  } catch (error) {
    console.error('Error refreshing session:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to refresh session',
    });
  }
}

/**
 * Look a token up among those a session has already rotated away.
 *
 * `benign` is true only for the token the session rotated away most recently,
 * and only inside the grace window: that is what two tabs refreshing at the
 * same moment look like. Anything older, or later, is a replay.
 */
async function findRotatedToken(tokenHash: string): Promise<{
  id: string; user_id: string; expires_at: string; revoked_at: string | null; benign: boolean;
} | null> {
  const result = await query<{
    id: string; user_id: string; expires_at: string; revoked_at: string | null;
    is_latest: boolean; age_ms: string | null;
  }>(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at,
            (s.previous_token_hash = r.token_hash) AS is_latest,
            EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - r.rotated_at)) * 1000 AS age_ms
     FROM session_rotated_tokens r
     JOIN sessions s ON s.id = r.session_id
     WHERE r.token_hash = $1`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  const grace = config.auth.refreshReuseGraceMs;
  const benign = grace > 0
    && row.is_latest === true
    && row.age_ms !== null
    && Number(row.age_ms) <= grace
    && !row.revoked_at;
  return { id: row.id, user_id: row.user_id, expires_at: row.expires_at, revoked_at: row.revoked_at, benign };
}

/** A rotated refresh token was replayed: end every session the account has. */
async function revokeAllSessionsForReuse(userId: string): Promise<void> {
  await query(
    `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  const account = await query<{ did: string }>(
    'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING did', [userId]);
  if (account.rows[0]?.did) await revokeOAuthGrants(account.rows[0].did);
  console.error(`SECURITY: Refresh token reuse detected for user ${userId}. All sessions revoked.`);
  await auditLog('session.reuseDetected', null, userId);
}
