import { Request, Response } from 'express';
import { query } from '../db/client.js';
import { requireRole } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import type { AuthRequest } from '../auth/types.js';

interface RevokeKeyInput {
  id: string;
}

export default async function revokePartnerKey(req: Request, res: Response): Promise<void> {
  if (!requireRole(req as AuthRequest, res, ['admin', 'partner-manager'])) return;
  const auth = (req as AuthRequest).auth!;

  const input: RevokeKeyInput = req.body;

  if (!input?.id) {
    res.status(400).json({
      error: 'InvalidRequest',
      message: 'id is required',
    });
    return;
  }

  try {
    const result = await query<{ id: string; name: string; partner_name: string; status: string }>(
      'SELECT id, name, partner_name, status FROM partner_keys WHERE id = $1',
      [input.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Partner key not found',
      });
      return;
    }

    const key = result.rows[0];

    if (key.status === 'revoked') {
      res.status(400).json({
        error: 'AlreadyRevoked',
        message: 'Partner key is already revoked',
      });
      return;
    }

    await query(
      `UPDATE partner_keys
       SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = $2
       WHERE id = $1`,
      [input.id, auth.userId]
    );

    auditLog('partner.key.revoke', auth.userId, input.id, {
      name: key.name,
      partnerName: key.partner_name,
    }).catch(() => {});

    res.json({
      id: input.id,
      status: 'revoked',
    });
  } catch (error) {
    console.error('Error revoking partner key:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to revoke partner key',
    });
  }
}
