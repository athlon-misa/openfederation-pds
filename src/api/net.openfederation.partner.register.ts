import { Request, Response } from 'express';
import { getClient, query } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { verifyPartnerKey } from '../auth/verification.js';
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

interface PartnerRegisterInput {
  handle: string;
  email: string;
  password: string;
}

export default async function partnerRegister(req: Request, res: Response): Promise<void> {
  // Authenticate via partner key (not JWT)
  const partnerAuth = await verifyPartnerKey({
    rawKey: req.headers['x-partner-key'] as string | undefined,
    origin: req.headers.origin as string | undefined,
    requiredPermission: 'register',
  });
  if (!partnerAuth.ok) {
    res.status(partnerAuth.status).json({ error: partnerAuth.code, message: partnerAuth.message });
    return;
  }
  const partner = partnerAuth.partner;

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

  // Per-partner rate limit: count registrations created in the last hour
  const rateResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM users
     WHERE created_by_partner = $1
     AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour'`,
    [partner.partnerId]
  );
  const recentCount = parseInt(rateResult.rows[0].count, 10);
  if (recentCount >= partner.rateLimitPerHour) {
    res.status(429).json({
      error: 'RateLimitExceeded',
      message: 'Partner registration rate limit exceeded. Please try again later.',
    });
    return;
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

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
      console.error('Error creating user identity (partner register):', err);
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
      status: 'approved',
      createdByPartner: partner.partnerId,
    });

    // Increment partner registration count
    await client.query(
      `UPDATE partner_keys SET total_registrations = total_registrations + 1 WHERE id = $1`,
      [partner.partnerId]
    );

    await client.query('COMMIT');

    await initializeUserRepoAsync(identity.did, handle, identity.signingKeyBase64);

    // Create session and issue tokens
    const accessJwt = await signAccessToken({
      userId,
      handle,
      email,
      did: identity.did,
      status: 'approved' as UserStatus,
      roles: ['user'],
    });

    const { token: refreshJwt, hash } = generateRefreshToken();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + refreshTtlMs());

    await query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, userId, hash, expiresAt.toISOString()]
    );

    // Audit log (fire-and-forget)
    auditLog('partner.register', partner.partnerId, userId, {
      handle,
      partnerName: partner.partnerName,
      did: identity.did,
    }).catch(() => {});

    res.status(201).json({
      id: userId,
      handle,
      did: identity.did,
      email,
      status: 'approved',
      accessJwt,
      refreshJwt,
      active: true,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error in partner registration:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to register account',
    });
  } finally {
    client.release();
  }
}
