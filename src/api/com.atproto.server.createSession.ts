import { Request, Response } from 'express';
import { query } from '../db/client.js';
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
    }>(
      'SELECT id, handle, email, password_hash, status, did, auth_type FROM users WHERE handle = $1 OR email = $1',
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
      await auditLog('session.loginFailed', null, user.id, {
        identifier: input.identifier, reason: 'wrong_password', ip: req.ip,
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid credentials',
      });
      return;
    }

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
    });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to create session',
    });
  }
}
