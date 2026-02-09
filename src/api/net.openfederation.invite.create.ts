import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { generateInviteCode } from '../auth/utils.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

interface InviteInput {
  maxUses?: number;
  expiresAt?: string;
}

export default async function createInvite(req: AuthRequest, res: Response): Promise<void> {
  if (!requireRole(req, res, ['admin', 'moderator'])) {
    return;
  }

  const input: InviteInput = req.body || {};
  const maxUses = input.maxUses ?? 1;

  if (!Number.isInteger(maxUses) || maxUses < 1) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'maxUses must be an integer greater than 0',
    });
    return;
  }

  let expiresAt: string | null = null;
  if (input.expiresAt) {
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'expiresAt must be an ISO date string',
      });
      return;
    }
    expiresAt = parsed.toISOString();
  }

  const code = generateInviteCode();

  await query(
    `INSERT INTO invites (code, created_by, max_uses, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [code, req.auth!.userId, maxUses, expiresAt]
  );

  await auditLog('invite.create', req.auth!.userId, null, { maxUses, expiresAt });

  res.status(201).json({
    code,
    maxUses,
    expiresAt,
  });
}
