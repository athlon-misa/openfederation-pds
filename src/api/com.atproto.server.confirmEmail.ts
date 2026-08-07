/**
 * Redeem an email-verification token (#83). ATProto-compatible shape:
 * `{ email, token }` in, distinct errors out.
 *
 * Deliberately does NOT require a session, diverging from upstream ATProto
 * (which authenticates this call): the token is itself the proof of mailbox
 * ownership, and under `require-for-login` an unverified user cannot create
 * the session upstream assumes — verification must work logged-out or that
 * policy deadlocks. When a session IS present, it must belong to the account
 * being verified: confirming someone else's address from your session is
 * nonsense, and refusing it keeps a stolen token from being laundered
 * through an unrelated login.
 */
import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { confirmEmailToken } from '../email/verification.js';

export default async function confirmEmail(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { email, token } = req.body ?? {};
    if (typeof email !== 'string' || typeof token !== 'string' || !email || !token) {
      res.status(400).json({ error: 'InvalidRequest', message: 'email and token are required' });
      return;
    }

    if (req.auth && req.auth.authMethod !== 'service-auth') {
      const own = await query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1', [req.auth.userId],
      );
      if (own.rows[0] && own.rows[0].email.toLowerCase() !== email.toLowerCase().trim()) {
        res.status(400).json({ error: 'InvalidEmail', message: 'This session does not belong to that email address' });
        return;
      }
    }

    const result = await confirmEmailToken(email, token);
    if (!result.ok) {
      const messages = {
        InvalidToken: 'Verification token is invalid or already used',
        ExpiredToken: 'Verification token has expired; request a new one',
        InvalidEmail: 'The token was not issued for this email address',
      } as const;
      res.status(400).json({ error: result.error, message: messages[result.error] });
      return;
    }

    res.status(200).json({ verified: true });
  } catch (error) {
    console.error('Error in confirmEmail:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to confirm email' });
  }
}
