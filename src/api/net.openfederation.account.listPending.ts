import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';

export default async function listPendingAccounts(req: AuthRequest, res: Response): Promise<void> {
  if (!requireRole(req, res, ['admin', 'moderator'])) {
    return;
  }

  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

  const result = await query<{
    id: string;
    handle: string;
    email: string;
    created_at: string;
  }>(
    `SELECT id, handle, email, created_at
     FROM users
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  res.status(200).json({
    users: result.rows,
    limit,
    offset,
  });
}
