import { Response } from 'express';
import { query } from '../db/client.js';
import { requireAuth } from '../auth/guards.js';
import type { AuthRequest } from '../auth/types.js';

export default async function listSessions(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  // Admin can view another user's sessions
  let targetUserId = req.auth.userId;
  const requestedDid = (req.query.did as string) || null;
  if (requestedDid && requestedDid !== req.auth.did) {
    if (!req.auth.roles.includes('admin')) {
      res.status(403).json({ error: 'Forbidden', message: "Only admins can view other users' sessions." });
      return;
    }
    const userResult = await query<{ id: string }>('SELECT id FROM users WHERE did = $1', [requestedDid]);
    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'User not found.' });
      return;
    }
    targetUserId = userResult.rows[0].id;
  }

  const result = await query<{
    id: string;
    created_at: Date | null;
    last_used_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT id, created_at, last_used_at, expires_at
     FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC NULLS LAST, expires_at DESC`,
    [targetUserId]
  );

  // Pseudonym sessions have no creation time (it could link them to their
  // owner's session by timing), so createdAt is omitted for them.
  const sessions = result.rows.map(row => ({
    id: row.id.substring(0, 8),
    ...(row.created_at ? { createdAt: new Date(row.created_at).toISOString() } : {}),
    ...(row.last_used_at ? { lastUsedAt: new Date(row.last_used_at).toISOString() } : {}),
    expiresAt: new Date(row.expires_at).toISOString(),
  }));

  res.status(200).json({ sessions });
}
