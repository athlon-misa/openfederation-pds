import { Request, Response } from 'express';
import { getClient, query } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import {
  isStrongPassword,
  isValidEmail,
  isValidHandle,
  normalizeEmail,
  normalizeHandle,
  passwordValidationMessage,
} from '../auth/utils.js';
import { validatePartnerKey } from '../auth/partner-guard.js';
import { signAccessToken, generateRefreshToken, refreshTtlMs } from '../auth/tokens.js';
import { createUserIdentity, storeUserSigningKey } from '../identity/user-identity.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
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
  const partner = await validatePartnerKey(req, res, 'register');
  if (!partner) return;

  const input: PartnerRegisterInput = req.body;

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

    // Check for existing user
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

    // Create real did:plc identity
    let identity;
    try {
      identity = await createUserIdentity(handle);
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
    const passwordHash = await hashPassword(input.password);

    // Insert user as approved (partner-registered users skip invite + approval)
    await client.query(
      `INSERT INTO users (id, handle, email, password_hash, status, did, approved_at, created_by_partner)
       VALUES ($1, $2, $3, $4, 'approved', $5, CURRENT_TIMESTAMP, $6)`,
      [userId, handle, email, passwordHash, identity.did, partner.partnerId]
    );

    await client.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, 'user')`,
      [userId]
    );

    // Increment partner registration count
    await client.query(
      `UPDATE partner_keys SET total_registrations = total_registrations + 1 WHERE id = $1`,
      [partner.partnerId]
    );

    await client.query('COMMIT');

    // Store signing key and create user repo (outside transaction)
    try {
      await storeUserSigningKey(identity.did, identity.signingKeyBase64);

      const engine = new RepoEngine(identity.did);
      const keypair = await getKeypairForDid(identity.did);
      await engine.createRepo(keypair, [
        {
          collection: 'app.bsky.actor.profile',
          rkey: 'self',
          record: { displayName: handle },
        },
      ]);
    } catch (err) {
      console.error('Warning: failed to create user repo (partner register, account still created):', err);
    }

    // Create session and issue tokens
    const accessJwt = signAccessToken({
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
