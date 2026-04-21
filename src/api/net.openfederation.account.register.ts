import { Request, Response } from 'express';
import { config } from '../config.js';
import { getClient } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { createUserIdentity } from '../identity/user-identity.js';
import {
  RegistrationValidationError,
  normalizeAndValidateCredentials,
  ensureHandleEmailAvailable,
  insertUserWithRole,
  initializeUserRepoAsync,
} from '../auth/account-creation.js';
import crypto from 'crypto';

interface RegisterInput {
  handle: string;
  email: string;
  password: string;
  inviteCode?: string;
}

export default async function registerAccount(req: Request, res: Response): Promise<void> {
  const input: RegisterInput = req.body;

  let credentials;
  try {
    credentials = normalizeAndValidateCredentials(input);
  } catch (err) {
    if (err instanceof RegistrationValidationError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }
  const { handle, email, password } = credentials;

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

    try {
      await ensureHandleEmailAvailable(client, handle, email);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof RegistrationValidationError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    if (config.auth.inviteRequired) {
      const inviteResult = await client.query<{
        code: string;
        max_uses: number;
        uses_count: number;
        expires_at: string | null;
        bound_to: string | null;
      }>(
        `SELECT code, max_uses, uses_count, expires_at, bound_to
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

      // Check email binding
      if (invite.bound_to) {
        const normalizedBound = invite.bound_to.toLowerCase().trim();
        const normalizedEmail = input.email.toLowerCase().trim();
        if (normalizedBound !== normalizedEmail) {
          await client.query('ROLLBACK');
          res.status(403).json({
            error: 'InviteBound',
            message: 'This invite code is bound to a specific email address.',
          });
          return;
        }
      }
    }

    // Create identity and hash password in parallel (independent operations)
    let identity;
    let passwordHash: string;
    try {
      [identity, passwordHash] = await Promise.all([
        createUserIdentity(handle),
        hashPassword(password),
      ]);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error creating user identity:', err);
      res.status(500).json({
        error: 'IdentityCreationFailed',
        message: 'Failed to create user identity. Please try again.',
      });
      return;
    }

    const userId = crypto.randomUUID();

    await insertUserWithRole(client, {
      userId,
      handle,
      email,
      passwordHash,
      did: identity.did,
      status: 'pending',
    });

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

    await initializeUserRepoAsync(identity.did, handle, identity.signingKeyBase64);

    res.status(201).json({
      id: userId,
      handle,
      did: identity.did,
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
