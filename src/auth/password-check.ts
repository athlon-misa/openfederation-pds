import { query } from '../db/client.js';
import { verifyPassword } from './password.js';

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'locked'; lockedUntil: Date; retryAfterSeconds: number }
  | { ok: false; reason: 'wrong'; attempts: number };

/**
 * Check an account's password, with the failed-attempt lockout applied.
 *
 * Every place that accepts a password goes through here (login, the OAuth
 * sign-in, and the endpoints that ask for the password again before a
 * sensitive change), so a guess counts the same wherever it is made.
 *
 * The attempt is counted *before* the password is verified, in one statement
 * that also refuses if the account is locked. Verifying first and counting
 * afterwards leaves a window as long as the hash takes: a burst of parallel
 * guesses all read "not locked" and each got a try, so the 5/10/15/20
 * thresholds capped nothing. Counted first, the sixth request of a burst finds
 * the lock the fifth one set. A correct password clears the count.
 *
 * Thresholds: 5/10/15/20 failures lock for 1 minute / 5 minutes / 30 minutes / 2 hours.
 */
export async function checkPasswordWithLockout(
  userId: string,
  passwordHash: string,
  password: string,
): Promise<PasswordCheck> {
  const reserved = await query<{ failed_login_attempts: number }>(
    `UPDATE users
     SET failed_login_attempts = failed_login_attempts + 1,
         locked_until = CASE
           WHEN failed_login_attempts + 1 >= 20 THEN CURRENT_TIMESTAMP + INTERVAL '2 hours'
           WHEN failed_login_attempts + 1 >= 15 THEN CURRENT_TIMESTAMP + INTERVAL '30 minutes'
           WHEN failed_login_attempts + 1 >= 10 THEN CURRENT_TIMESTAMP + INTERVAL '5 minutes'
           WHEN failed_login_attempts + 1 >= 5 THEN CURRENT_TIMESTAMP + INTERVAL '1 minute'
           ELSE NULL
         END
     WHERE id = $1 AND (locked_until IS NULL OR locked_until <= CURRENT_TIMESTAMP)
     RETURNING failed_login_attempts`,
    [userId],
  );

  if (reserved.rows.length === 0) {
    const row = await query<{ locked_until: string | null }>('SELECT locked_until FROM users WHERE id = $1', [userId]);
    const lockedUntil = row.rows[0]?.locked_until ? new Date(row.rows[0].locked_until) : new Date();
    return {
      ok: false,
      reason: 'locked',
      lockedUntil,
      retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000)),
    };
  }

  if (await verifyPassword(password, passwordHash)) {
    await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [userId]);
    return { ok: true };
  }
  return { ok: false, reason: 'wrong', attempts: reserved.rows[0].failed_login_attempts };
}
