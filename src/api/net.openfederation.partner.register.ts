import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requirePartnerAuth } from '../auth/guards.js';
import { query, withTransaction } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { signAccessToken, generateRefreshToken, refreshTtlMs } from '../auth/tokens.js';
import { createUserIdentity } from '../identity/user-identity.js';
import {
  RegistrationValidationError,
  normalizeAndValidateCredentials,
  ensureHandleEmailAvailable,
  insertUserWithRole,
  initializeUserRepoAsync,
} from '../auth/account-creation.js';
import { auditLog } from '../db/audit.js';
import type { UserStatus } from '../auth/types.js';
import crypto from 'crypto';
import { redeemPartnerTicket, PartnerTicketError } from '../auth/partner-ticket.js';
import { issueEmailVerification } from '../email/verification.js';

interface PartnerRegisterInput {
  handle: string;
  email: string;
  password: string;
  /** A registration ticket signed by the partner's backend; required when the key has a ticket key. */
  ticket?: string;
}

export default async function partnerRegister(req: AuthRequest, res: Response): Promise<void> {
  if (!requirePartnerAuth(req, res, 'register')) return;
  const partner = req.partnerAuth!;

  const input: PartnerRegisterInput = req.body;

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

  try {
    const result = await withTransaction(async (client) => {
      // Serialize registrations for this key before reading its quota. Without
      // this row lock, simultaneous requests can both see available capacity.
      const partnerKey = await client.query<{ rate_limit_per_hour: number; ticket_public_key: string | null }>(
        `SELECT rate_limit_per_hour, ticket_public_key FROM partner_keys
         WHERE id = $1 AND status = 'active'
         FOR UPDATE`,
        [partner.partnerId],
      );
      if (partnerKey.rows.length === 0) {
        throw new RegistrationValidationError(401, 'Unauthorized', 'Partner key is no longer active');
      }

      const rateResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM users
         WHERE created_by_partner = $1
         AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour'`,
        [partner.partnerId],
      );
      if (parseInt(rateResult.rows[0].count, 10) >= partnerKey.rows[0].rate_limit_per_hour) {
        throw new RegistrationValidationError(
          429,
          'RateLimitExceeded',
          'Partner registration rate limit exceeded. Please try again later.',
        );
      }

      await ensureHandleEmailAvailable(client, handle, email);

      // Having the partner key proves nothing: it is in the partner's page for
      // anyone to copy. What this sign-up is worth depends on what else came
      // with it. A ticket signed by the partner's backend is the partner
      // vouching for it: approved, and signed in. Without one (a partner with
      // no backend) the account is created but stays pending until whoever
      // holds the email address proves it.
      const ticketKey = partnerKey.rows[0].ticket_public_key;
      const vouched = ticketKey !== null;
      if (ticketKey !== null) {
        await redeemPartnerTicket(client, {
          ticket: input.ticket, ticketPublicKey: ticketKey, partnerKeyId: partner.partnerId, handle, email,
        });
      }

      let identity;
      let passwordHash: string;
      try {
        [identity, passwordHash] = await Promise.all([
          createUserIdentity(handle),
          hashPassword(password),
        ]);
      } catch (err) {
        console.error('Error creating user identity (partner register):', err);
        throw new RegistrationValidationError(
          500,
          'IdentityCreationFailed',
          'Failed to create user identity. Please try again.',
        );
      }

      const userId = crypto.randomUUID();

      await insertUserWithRole(client, {
        userId,
        handle,
        email,
        passwordHash,
        did: identity.did,
        status: vouched ? 'approved' : 'pending',
        createdByPartner: partner.partnerId,
      });

      await client.query(
        `UPDATE partner_keys SET total_registrations = total_registrations + 1 WHERE id = $1`,
        [partner.partnerId],
      );

      return { userId, identity, vouched };
    });

    await initializeUserRepoAsync(result.identity.did, handle, result.identity.signingKeyBase64);

    if (!result.vouched) {
      // No session. The account becomes usable when its email is verified
      // (confirmEmailToken approves partner-created pending accounts).
      const delivery = await issueEmailVerification({ id: result.userId, handle, email });
      auditLog('partner.register', partner.partnerId, result.userId, {
        handle, partnerName: partner.partnerName, did: result.identity.did,
        mode: 'email-verification', delivery: delivery.outcome,
      }).catch(() => {});
      res.status(201).json({
        id: result.userId,
        handle,
        did: result.identity.did,
        email,
        status: 'pending',
        emailVerificationRequired: true,
        active: false,
      });
      return;
    }

    const accessJwt = await signAccessToken({
      userId: result.userId,
      handle,
      email,
      did: result.identity.did,
      status: 'approved' as UserStatus,
      roles: ['user'],
      tokenVersion: 0,
    });

    const { token: refreshJwt, hash } = generateRefreshToken();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + refreshTtlMs());

    await query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, result.userId, hash, expiresAt.toISOString()],
    );

    auditLog('partner.register', partner.partnerId, result.userId, {
      handle,
      partnerName: partner.partnerName,
      did: result.identity.did,
    }).catch(() => {});

    res.status(201).json({
      id: result.userId,
      handle,
      did: result.identity.did,
      email,
      status: 'approved',
      accessJwt,
      refreshJwt,
      active: true,
    });
  } catch (err) {
    if (err instanceof RegistrationValidationError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof PartnerTicketError) {
      res.status(401).json({ error: err.code, message: err.message });
      return;
    }
    console.error('Error in partner registration:', err);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to register account',
    });
  }
}
