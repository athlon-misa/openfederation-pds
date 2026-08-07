/**
 * Email verification: proving the address on the account is really yours
 * (#83, part B).
 *
 * The token mechanics mirror `password_reset_tokens` deliberately — hashed at
 * rest, single-use, expiring — because that pattern already survived a
 * security review and two implementations of the same idea would drift. The
 * raw token exists only inside the emailed link; the database holds its
 * SHA-256, so a database compromise cannot mint valid links.
 *
 * The token records the address it was issued for, and confirmation checks it
 * against both the presented email and the account's *current* email. An
 * address change between issue and confirm therefore invalidates the link
 * rather than verifying an address the user no longer claims.
 *
 * What verification *gates* is the operator's decision, not this module's:
 * `EMAIL_VERIFICATION_POLICY` (see `config.emailVerification`) ranges from
 * `off` to `require-for-login`, defaulting to `advisory` — recorded and
 * surfaced, blocking nothing. An open-source PDS serves operators from
 * closed single-user instances to open registration, and one strictness
 * cannot fit both.
 */
import crypto from 'crypto';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { sendEmail, type DeliveryOutcome } from './email-service.js';
import { config } from '../config.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function verificationEmailHtml(handle: string, url: string): string {
  return `<!DOCTYPE html><html><body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 2rem;">
    <h2>Verify your email</h2>
    <p>Hi <strong>${handle}</strong>,</p>
    <p>Confirm that this is your email address by clicking the link below. The link expires in 24 hours.</p>
    <p><a href="${url}" style="display: inline-block; background: #1a73e8; color: #fff; padding: 0.75rem 1.5rem; border-radius: 4px; text-decoration: none;">Verify email</a></p>
    <p>Or open this URL:</p>
    <p style="word-break: break-all; font-family: monospace; font-size: 0.9rem;">${url}</p>
    <p>If you did not create an account, ignore this email.</p>
  </body></html>`;
}

/**
 * Issue a fresh verification token and email the link.
 *
 * Previous unused tokens for the user are invalidated first: the newest link
 * is the valid one, and a drawer full of live tokens is more attack surface
 * for no user benefit. Returns the delivery outcome so callers can decide
 * what a failed send means for them.
 */
export async function issueEmailVerification(user: {
  id: string;
  handle: string;
  email: string;
}): Promise<DeliveryOutcome> {
  const token = crypto.randomBytes(48).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await query(
    `DELETE FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL`,
    [user.id],
  );
  await query(
    `INSERT INTO email_verification_tokens (id, user_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), user.id, user.email.toLowerCase(), tokenHash, expiresAt.toISOString()],
  );

  const baseUrl = config.pds.serviceUrl || `http://localhost:${config.port}`;
  const url = `${baseUrl}/verify-email?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  return sendEmail(user.email, 'Verify your email — OpenFederation', verificationEmailHtml(user.handle, url), 'email-verification');
}

export type ConfirmResult =
  | { ok: true; userId: string }
  | { ok: false; error: 'InvalidToken' | 'ExpiredToken' | 'InvalidEmail' };

/**
 * Redeem a verification token. The token is the proof of ownership, so no
 * session is required — which is also what keeps `require-for-login` from
 * deadlocking (a user who cannot log in until verified must be able to
 * verify while logged out).
 */
export async function confirmEmailToken(email: string, token: string): Promise<ConfirmResult> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const normalized = email.toLowerCase().trim();

  const result = await query<{ id: string; user_id: string; email: string; expired: boolean }>(
    `SELECT id, user_id, email, (expires_at < NOW()) AS expired
     FROM email_verification_tokens
     WHERE token_hash = $1 AND used_at IS NULL`,
    [tokenHash],
  );
  if (result.rows.length === 0) return { ok: false, error: 'InvalidToken' };

  const row = result.rows[0];
  if (row.expired) return { ok: false, error: 'ExpiredToken' };

  // Burn the token BEFORE the email comparison — a redemption attempt is a
  // use. A correct token presented with the wrong address is a token that
  // has leaked far enough to be tried, and it should die rather than remain
  // redeemable by whoever tries next.
  await query(`UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1`, [row.id]);

  if (row.email !== normalized) return { ok: false, error: 'InvalidEmail' };

  // The account's email must still be the one the token was issued for: a
  // change in between means the user no longer claims this address.
  const updated = await query<{ id: string }>(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW())
     WHERE id = $1 AND LOWER(email) = $2
     RETURNING id`,
    [row.user_id, normalized],
  );
  if (updated.rows.length === 0) return { ok: false, error: 'InvalidEmail' };

  await auditLog('account.email.verified', null, row.user_id, { email: normalized });
  return { ok: true, userId: row.user_id };
}
