import { Request, Response } from 'express';
import { config } from '../config.js';
import { getClient } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import {
  createAccountDid,
  isStrongPassword,
  isValidEmail,
  isValidHandle,
  normalizeEmail,
  normalizeHandle,
  passwordValidationMessage,
} from '../auth/utils.js';
import crypto from 'crypto';

interface RegisterInput {
  handle: string;
  email: string;
  password: string;
  inviteCode?: string;
}

export default async function registerAccount(req: Request, res: Response): Promise<void> {
  const input: RegisterInput = req.body;

  if (!input?.handle || !input?.email || !input?.password) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'handle, email, and password are required',
    });
    return;
  }

  const handle = normalizeHandle(input.handle);
  const email = normalizeEmail(input.email);

  if (!isValidHandle(handle)) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'Handle must be 3-30 characters, lowercase letters, numbers, and hyphens only. No leading/trailing hyphens or consecutive hyphens. Some names are reserved.',
    });
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'Email is invalid',
    });
    return;
  }

  if (!isStrongPassword(input.password)) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: passwordValidationMessage(),
    });
    return;
  }

  if (config.auth.inviteRequired && !input.inviteCode) {
    res.status(403).json({
      error: 'InviteRequired',
      message: 'An invite code is required to register',
    });
    return;
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    let inviteCodeToUse: string | null = null;
    let inviteMaxUses: number | null = null;

    const existing = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE handle = $1 OR email = $2',
      [handle, email]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      res.status(409).json({
        error: 'AccountExists',
        message: 'Handle or email is already in use',
      });
      return;
    }

    if (config.auth.inviteRequired) {
      const inviteResult = await client.query<{
        code: string;
        max_uses: number;
        uses_count: number;
        expires_at: string | null;
      }>(
        `SELECT code, max_uses, uses_count, expires_at
         FROM invites
         WHERE code = $1
         FOR UPDATE`,
        [input.inviteCode]
      );

      if (inviteResult.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(403).json({
          error: 'InviteInvalid',
          message: 'Invite code is invalid',
        });
        return;
      }

      const invite = inviteResult.rows[0];
      inviteCodeToUse = invite.code;
      inviteMaxUses = invite.max_uses;
      if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        res.status(403).json({
          error: 'InviteExpired',
          message: 'Invite code has expired',
        });
        return;
      }

      if (invite.uses_count >= invite.max_uses) {
        await client.query('ROLLBACK');
        res.status(403).json({
          error: 'InviteUsed',
          message: 'Invite code has already been used',
        });
        return;
      }

    }

    const userId = crypto.randomUUID();
    const did = createAccountDid();
    const passwordHash = await hashPassword(input.password);

    await client.query(
      `INSERT INTO users (id, handle, email, password_hash, status, did)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [userId, handle, email, passwordHash, did]
    );

    await client.query(
      `INSERT INTO user_roles (user_id, role)
       VALUES ($1, 'user')`,
      [userId]
    );

    if (inviteCodeToUse) {
      const usedBy = inviteMaxUses === 1 ? userId : null;
      await client.query(
        `UPDATE invites
         SET uses_count = uses_count + 1,
             used_by = COALESCE($2, used_by),
             used_at = CURRENT_TIMESTAMP
         WHERE code = $1`,
        [inviteCodeToUse, usedBy]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      id: userId,
      handle,
      email,
      status: 'pending',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error registering account:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to register account',
    });
  } finally {
    client.release();
  }
}
