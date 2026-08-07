import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { verifyPassword } from '../auth/password.js';
import { signAccessToken, generateRefreshToken, refreshTtlMs } from '../auth/tokens.js';
import { normalizeEmail, normalizeHandle } from '../auth/utils.js';
import type { UserRole, UserStatus } from '../auth/types.js';
import crypto from 'crypto';
import { auditLog } from '../db/audit.js';

interface CreateSessionInput {
  identifier: string;
  password: string;
}

export default async function createSession(req: Request, res: Response): Promise<void> {
  try {
    const input: CreateSessionInput = req.body;
    if (!input?.identifier || !input?.password) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'identifier and password are required',
      });
      return;
    }

    const identifier = input.identifier.includes('@')
      ? normalizeEmail(input.identifier)
      : normalizeHandle(input.identifier);

    const userResult = await query<{
      id: string;
      handle: string;
      email: string;
      password_hash: string | null;
      status: string;
      did: string;
      auth_type: string;
      failed_login_attempts: number;
      locked_until: string | null;
      token_version: number;
    }>(
      'SELECT id, handle, email, password_hash, status, did, auth_type, failed_login_attempts, locked_until, token_version FROM users WHERE handle = $1 OR email = $1',
      [identifier]
    );

    if (userResult.rows.length === 0) {
      await auditLog('session.loginFailed', null, null, {
        identifier: input.identifier, reason: 'user_not_found', ip: req.ip,
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid credentials',
      });
      return;
    }

    const user = userResult.rows[0];

    // Check if account is locked
    if (user.locked_until) {
      const lockExpiry = new Date(user.locked_until);
      if (lockExpiry > new Date()) {
        const remainingSec = Math.ceil((lockExpiry.getTime() - Date.now()) / 1000);
        await auditLog('session.loginFailed', null, user.id, {
          identifier: input.identifier, reason: 'account_locked', ip: req.ip,
          lockedUntil: user.locked_until,
        });
        res.status(429).json({
          error: 'AccountLocked',
          message: `Too many failed attempts. Try again in ${remainingSec} seconds.`,
          retryAfter: remainingSec,
        });
        return;
      }
    }

    // External users cannot log in via password — they must use ATProto OAuth
    if (user.auth_type === 'external') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier, reason: 'external_account', ip: req.ip,
      });
      res.status(400).json({
        error: 'ExternalAccount',
        message: 'This account uses ATProto OAuth. Please sign in via your home PDS.',
      });
      return;
    }

    if (!user.password_hash) {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier, reason: 'no_password_hash', ip: req.ip,
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid credentials',
      });
      return;
    }

    const passwordOk = await verifyPassword(input.password, user.password_hash);
    if (!passwordOk) {
      const failure = await query<{ failed_login_attempts: number }>(
        `UPDATE users
         SET failed_login_attempts = failed_login_attempts + 1,
             locked_until = CASE
               WHEN failed_login_attempts + 1 >= 20 THEN CURRENT_TIMESTAMP + INTERVAL '2 hours'
               WHEN failed_login_attempts + 1 >= 15 THEN CURRENT_TIMESTAMP + INTERVAL '30 minutes'
               WHEN failed_login_attempts + 1 >= 10 THEN CURRENT_TIMESTAMP + INTERVAL '5 minutes'
               WHEN failed_login_attempts + 1 >= 5 THEN CURRENT_TIMESTAMP + INTERVAL '1 minute'
               ELSE NULL
             END
         WHERE id = $1
         RETURNING failed_login_attempts`,
        [user.id],
      );
      const attempts = failure.rows[0].failed_login_attempts;

      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier, reason: 'wrong_password', ip: req.ip,
        attempts,
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid credentials',
      });
      return;
    }

    // Reset failed login counter and fetch roles in parallel (independent operations)
    const [, rolesResult] = await Promise.all([
      user.failed_login_attempts > 0
        ? query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id])
        : Promise.resolve(undefined),
      query<{ role: UserRole }>('SELECT role FROM user_roles WHERE user_id = $1', [user.id]),
    ]);
    const roles = rolesResult.rows.map((row) => row.role);

    if (user.status === 'suspended') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier, reason: 'account_suspended', ip: req.ip,
      });
      res.status(403).json({
        error: 'AccountSuspended',
        message: 'Your account has been suspended.',
      });
      return;
    }

    if (user.status === 'takendown') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier, reason: 'account_takendown', ip: req.ip,
      });
      res.status(410).json({
        error: 'AccountTakenDown',
        message: 'Your account has been taken down.',
      });
      return;
    }

    if (user.status === 'deactivated') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier, reason: 'account_deactivated', ip: req.ip,
      });
      res.status(403).json({
        error: 'AccountDeactivated',
        message: 'Your account is deactivated. Reactivate it to continue.',
      });
      return;
    }

    if (user.status !== 'approved') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier, reason: 'account_not_approved', ip: req.ip,
      });
      res.status(403).json({
        error: 'AccountNotApproved',
        message: 'Your account must be approved before logging in.',
      });
      return;
    }

    const accessJwt = await signAccessToken({
      userId: user.id,
      handle: user.handle,
      email: user.email,
      did: user.did,
      status: user.status as UserStatus,
      roles,
      tokenVersion: user.token_version,
    });

    // Under require-for-login, an unverified local account authenticates
    // correctly and is still refused a session — with an error that names the
    // way out. confirmEmail deliberately works without a session, so this
    // cannot deadlock (#83).
    if (config.emailVerification.policy === 'require-for-login') {
      const verified = await query<{ v: boolean }>(
        'SELECT (email_verified_at IS NOT NULL) AS v FROM users WHERE id = $1', [user.id],
      );
      if (!verified.rows[0]?.v) {
        await auditLog('session.loginFailed', null, user.id, {
          identifier: input.identifier, reason: 'email_not_verified', ip: req.ip,
        });
        res.status(403).json({
          error: 'EmailNotVerified',
          message: 'Verify your email address before signing in. Use the link you were sent, or com.atproto.server.confirmEmail with a fresh token.',
        });
        return;
      }
    }

    const { token: refreshJwt, hash } = generateRefreshToken();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + refreshTtlMs());

    await query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, user.id, hash, expiresAt.toISOString()]
    );

    res.status(200).json({
      did: user.did,
      handle: user.handle,
      email: user.email,
      accessJwt,
      refreshJwt,
      active: true,
      roles,
    });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to create session',
    });
  }
}
