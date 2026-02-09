import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { normalizeEmail, normalizeHandle } from '../auth/utils.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

interface RejectInput {
  userId?: string;
  handle?: string;
  email?: string;
}

export default async function rejectAccount(req: AuthRequest, res: Response): Promise<void> {
  if (!requireRole(req, res, ['admin', 'moderator'])) {
    return;
  }

  const input: RejectInput = req.body || {};
  const userId = input.userId?.trim();
  const handle = input.handle ? normalizeHandle(input.handle) : '';
  const email = input.email ? normalizeEmail(input.email) : '';

  if (!userId && !handle && !email) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'userId, handle, or email is required',
    });
    return;
  }

  const criteria: string[] = [];
  const values: string[] = [];
  let paramIndex = 1;

  if (userId) {
    criteria.push(`id = $${paramIndex++}`);
    values.push(userId);
  }
  if (handle) {
    criteria.push(`handle = $${paramIndex++}`);
    values.push(handle);
  }
  if (email) {
    criteria.push(`email = $${paramIndex++}`);
    values.push(email);
  }

  const whereClause = criteria.join(' OR ');

  const { rows } = await query<{
    id: string;
    handle: string;
    email: string;
    status: string;
  }>(
    `UPDATE users
     SET status = 'rejected'
     WHERE (${whereClause}) AND status = 'pending'
     RETURNING id, handle, email, status`,
    values
  );

  if (rows.length === 0) {
    res.status(404).json({
      error: 'NotFound',
      message: 'No pending user found matching the criteria',
    });
    return;
  }

  await auditLog('account.reject', req.auth!.userId, rows[0].id, {
    handle: rows[0].handle,
  });

  res.status(200).json(rows[0]);
}
