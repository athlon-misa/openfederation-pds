/**
 * Resend the email-verification link (#83). ATProto-compatible shape: an
 * authenticated procedure with no input — the address is the one on the
 * account, never caller-supplied.
 *
 * Idempotent on an already-verified account: a 200 no-op, because "the state
 * you asked for already holds" is not an error, and a client retrying after
 * a slow confirm should not see one.
 */
import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { issueEmailVerification } from '../email/verification.js';
import { config } from '../config.js';

export default async function requestEmailConfirmation(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    if (config.emailVerification.policy === 'off') {
      res.status(400).json({
        error: 'VerificationDisabled',
        message: 'Email verification is disabled on this server (EMAIL_VERIFICATION_POLICY=off).',
      });
      return;
    }

    const user = await query<{ id: string; handle: string; email: string; verified: boolean }>(
      'SELECT id, handle, email, (email_verified_at IS NOT NULL) AS verified FROM users WHERE id = $1',
      [req.auth!.userId],
    );
    if (user.rows.length === 0) {
      res.status(404).json({ error: 'AccountNotFound', message: 'Account not found' });
      return;
    }
    if (user.rows[0].verified) {
      res.status(200).json({ alreadyVerified: true });
      return;
    }

    // The caller is authenticated and asking about their own account, so
    // there is no enumeration concern — delivery failure is surfaced, since
    // the whole point of this endpoint is that the previous email did not
    // arrive.
    const delivery = await issueEmailVerification(user.rows[0]);
    if (delivery.outcome === 'failed-transient' || delivery.outcome === 'failed-permanent' || delivery.outcome === 'suppressed') {
      res.status(502).json({
        error: 'EmailDeliveryFailed',
        message: `The verification email could not be sent (${delivery.outcome}). Try again later or contact the operator.`,
      });
      return;
    }

    res.status(200).json({
      alreadyVerified: false,
      ...(delivery.outcome === 'not-configured' ? { note: 'Email is not configured on this server; the link was logged to the server console.' } : {}),
    });
  } catch (error) {
    console.error('Error in requestEmailConfirmation:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to request email confirmation' });
  }
}
