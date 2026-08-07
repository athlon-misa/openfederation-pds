import { Request, Response } from 'express';
import { config } from '../config.js';
import { withTransaction } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { issueEmailVerification } from '../email/verification.js';
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

  try {
    // Identity creation talks to the PLC directory and password hashing is
    // CPU-bound. Neither may run while the invite row is locked, otherwise a
    // slow external call can block every contender for that invite.
    let identity;
    let passwordHash: string;
    try {
      [identity, passwordHash] = await Promise.all([
        createUserIdentity(handle),
        hashPassword(password),
      ]);
    } catch (err) {
      console.error('Error creating user identity:', err);
      throw new RegistrationValidationError(
        500,
        'IdentityCreationFailed',
        'Failed to create user identity. Please try again.',
      );
    }

    const result = await withTransaction(async (client) => {
      await ensureHandleEmailAvailable(client, handle, email);

      let inviteCodeToUse: string | null = null;
      let inviteMaxUses: number | null = null;

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
          [input.inviteCode],
        );

        if (inviteResult.rows.length === 0) {
          throw new RegistrationValidationError(403, 'InviteInvalid', 'Invite code is invalid');
        }

        const invite = inviteResult.rows[0];
        if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
          throw new RegistrationValidationError(403, 'InviteExpired', 'Invite code has expired');
        }
        if (invite.uses_count >= invite.max_uses) {
          throw new RegistrationValidationError(403, 'InviteUsed', 'Invite code has already been used');
        }
        if (invite.bound_to) {
          const normalizedBound = invite.bound_to.toLowerCase().trim();
          const normalizedEmail = input.email.toLowerCase().trim();
          if (normalizedBound !== normalizedEmail) {
            throw new RegistrationValidationError(
              403,
              'InviteBound',
              'This invite code is bound to a specific email address.',
            );
          }
        }

        inviteCodeToUse = invite.code;
        inviteMaxUses = invite.max_uses;
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
          [inviteCodeToUse, usedBy],
        );
      }

      return { userId, identity };
    });

    await initializeUserRepoAsync(result.identity.did, handle, result.identity.signingKeyBase64);

    // Verification email, off the response path: registration succeeded
    // whether or not the link could be sent, and the resend endpoint exists
    // for exactly the case where it could not (#83).
    if (config.emailVerification.policy !== 'off') {
      void issueEmailVerification({ id: result.userId, handle, email }).then((delivery) => {
        if (delivery.outcome !== 'sent' && delivery.outcome !== 'not-configured') {
          console.error(`[email] verification link for ${handle} was not delivered: ${delivery.outcome}`);
        }
      }).catch((err) => console.error('[email] verification send failed:', err));
    }

    res.status(201).json({
      id: result.userId,
      handle,
      did: result.identity.did,
      email,
      status: 'pending',
    });
  } catch (err) {
    if (err instanceof RegistrationValidationError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    console.error('Error registering account:', err);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to register account',
    });
  }
}
