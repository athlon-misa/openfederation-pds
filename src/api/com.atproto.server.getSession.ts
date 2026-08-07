import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';

export default async function getSession(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) {
    return;
  }

  // Fresh from the database rather than the token: a claim would keep
  // reading "unverified" after the user verifies mid-session (#83).
  let emailConfirmed = false;
  try {
    const row = await query<{ v: boolean }>(
      'SELECT (email_verified_at IS NOT NULL) AS v FROM users WHERE id = $1',
      [req.auth.userId],
    );
    emailConfirmed = row.rows[0]?.v ?? false;
  } catch {
    // Advisory data; the session itself is not in question.
  }

  res.status(200).json({
    did: req.auth.did,
    handle: req.auth.handle,
    email: req.auth.email,
    emailConfirmed,
    active: true,
    status: req.auth.status,
    roles: req.auth.roles,
  });
}
