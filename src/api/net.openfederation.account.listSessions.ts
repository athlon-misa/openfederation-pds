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
    created_at: string;
    last_used_at: string | null;
    expires_at: string;
  }>(
    `SELECT id, created_at, last_used_at, expires_at
     FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [targetUserId]
  );

  const sessions = result.rows.map(row => ({
    id: row.id.substring(0, 8),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    expiresAt: row.expires_at,
  }));

  res.status(200).json({ sessions });
}
