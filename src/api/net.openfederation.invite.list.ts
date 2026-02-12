import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';

export default async function listInvites(req: AuthRequest, res: Response): Promise<void> {
  if (!requireRole(req, res, ['admin', 'moderator'])) {
    return;
  }

  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const status = req.query.status ? String(req.query.status) : undefined;

  const validStatuses = ['active', 'expired', 'exhausted'];
  if (status && !validStatuses.includes(status)) {
    res.status(400).json({ error: 'InvalidRequest', message: 'Invalid status filter' });
    return;
  }

  try {
    // Build conditions based on status filter
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (status === 'active') {
      conditions.push(`i.uses_count < i.max_uses`);
      conditions.push(`(i.expires_at IS NULL OR i.expires_at > NOW())`);
    } else if (status === 'expired') {
      conditions.push(`i.expires_at IS NOT NULL AND i.expires_at <= NOW()`);
    } else if (status === 'exhausted') {
      conditions.push(`i.uses_count >= i.max_uses`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM invites i ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const dataParams = [...params, limit, offset];
    const dataResult = await query<{
      code: string;
      max_uses: number;
      uses_count: number;
      expires_at: string | null;
      created_at: string;
      created_by: string;
      creator_handle: string | null;
    }>(
      `SELECT i.code, i.max_uses, i.uses_count, i.expires_at, i.created_at, i.created_by,
              u.handle as creator_handle
       FROM invites i
       LEFT JOIN users u ON u.id = i.created_by
       ${whereClause}
       ORDER BY i.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      dataParams
    );

    const invites = dataResult.rows.map(i => {
      let computedStatus: string;
      if (i.uses_count >= i.max_uses) {
        computedStatus = 'exhausted';
      } else if (i.expires_at && new Date(i.expires_at) <= new Date()) {
        computedStatus = 'expired';
      } else {
        computedStatus = 'active';
      }

      return {
        code: i.code,
        maxUses: i.max_uses,
        usesCount: i.uses_count,
        expiresAt: i.expires_at,
        createdAt: i.created_at,
        createdByHandle: i.creator_handle || 'unknown',
        status: computedStatus,
      };
    });

    res.status(200).json({ invites, total, limit, offset });
  } catch (error) {
    console.error('Error listing invites:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list invites' });
  }
}
