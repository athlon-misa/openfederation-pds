import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { runtimeSettings } from '../settings/runtime-settings.js';
import { verifyPassword } from '../auth/password.js';
import { issueSession } from '../auth/session-issue.js';
import { fullHandle, localHandle, normalizeEmail } from '../auth/utils.js';
import { auditLog } from '../db/audit.js';
import { checkPasswordWithLockout } from '../auth/password-check.js';

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
      : localHandle(input.identifier);

    // What goes into the audit log for a failed login. The raw field is
    // whatever was typed, which is sometimes a password pasted into the wrong
    // box and can be as large as the request body; the log gets the
    // normalised, length-capped form only.
    const auditIdentifier = identifier.slice(0, 254);

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
        identifier: auditIdentifier, reason: 'user_not_found', ip: req.ip,
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid credentials',
      });
      return;
    }

    const user = userResult.rows[0];

    // Pseudonyms have no password. Same answer as a wrong password, and no audit.
    if (user.auth_type === 'pseudonym') {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials' });
      return;
    }

    // External users cannot log in via password — they must use ATProto OAuth
    if (user.auth_type === 'external') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: auditIdentifier, reason: 'external_account', ip: req.ip,
      });
      res.status(400).json({
        error: 'ExternalAccount',
        message: 'This account uses ATProto OAuth. Please sign in via your home PDS.',
      });
      return;
    }

    if (!user.password_hash) {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: auditIdentifier, reason: 'no_password_hash', ip: req.ip,
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid credentials',
      });
      return;
    }

    const check = await checkPasswordWithLockout(user.id, user.password_hash, input.password);
    if (!check.ok && check.reason === 'locked') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: auditIdentifier, reason: 'account_locked', ip: req.ip,
        lockedUntil: check.lockedUntil.toISOString(),
      });
      res.status(429).json({
        error: 'AccountLocked',
        message: `Too many failed attempts. Try again in ${check.retryAfterSeconds} seconds.`,
        retryAfter: check.retryAfterSeconds,
      });
      return;
    }
    if (!check.ok) {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: auditIdentifier, reason: 'wrong_password', ip: req.ip,
        attempts: check.attempts,
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid credentials',
      });
      return;
    }

    if (user.status === 'suspended') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: auditIdentifier, reason: 'account_suspended', ip: req.ip,
      });
      res.status(403).json({
        error: 'AccountSuspended',
        message: 'Your account has been suspended.',
      });
      return;
    }

    if (user.status === 'takendown') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: auditIdentifier, reason: 'account_takendown', ip: req.ip,
      });
      res.status(410).json({
        error: 'AccountTakenDown',
        message: 'Your account has been taken down.',
      });
      return;
    }

    // A deactivated account gets a session limited to checking on, filling,
    // activating or backing up the account (#265), so it is never locked out.
    const deactivated = user.status === 'deactivated';
    if (!deactivated && user.status !== 'approved') {
      await auditLog('session.loginFailed', null, user.id, {
        identifier: auditIdentifier, reason: 'account_not_approved', ip: req.ip,
      });
      res.status(403).json({
        error: 'AccountNotApproved',
        message: 'Your account must be approved before logging in.',
      });
      return;
    }

    // Under require-for-login, an unverified local account authenticates
    // correctly and is still refused a session — with an error that names the
    // way out. confirmEmail deliberately works without a session, so this
    // cannot deadlock (#83).
    if (runtimeSettings().emailVerificationPolicy === 'require-for-login') {
      const verified = await query<{ v: boolean }>(
        'SELECT (email_verified_at IS NOT NULL) AS v FROM users WHERE id = $1', [user.id],
      );
      if (!verified.rows[0]?.v) {
        await auditLog('session.loginFailed', null, user.id, {
          identifier: auditIdentifier, reason: 'email_not_verified', ip: req.ip,
        });
        res.status(403).json({
          error: 'EmailNotVerified',
          message: 'Verify your email address before signing in. Use the link you were sent, or com.atproto.server.confirmEmail with a fresh token.',
        });
        return;
      }
    }

    const { accessJwt, refreshJwt, roles } = await issueSession(user);

    res.status(200).json({
      did: user.did,
      handle: fullHandle(user.handle),
      email: user.email,
      accessJwt,
      refreshJwt,
      active: !deactivated,
      ...(deactivated ? { status: 'deactivated' } : {}),
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
