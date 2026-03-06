import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';

export default async function listAudit(req: AuthRequest, res: Response): Promise<void> {
  if (!requireRole(req, res, ['admin', 'auditor'])) {
    return;
  }

  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const action = req.query.action ? String(req.query.action) : undefined;
  const actorId = req.query.actorId ? String(req.query.actorId) : undefined;
  const targetId = req.query.targetId ? String(req.query.targetId) : undefined;
  const since = req.query.since ? String(req.query.since) : undefined;
  const until = req.query.until ? String(req.query.until) : undefined;

  try {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (action) {
      conditions.push(`a.action = $${paramIndex}`);
      params.push(action);
      paramIndex++;
    }

    if (actorId) {
      conditions.push(`a.actor_id = $${paramIndex}`);
      params.push(actorId);
      paramIndex++;
    }

    if (targetId) {
      conditions.push(`a.target_id = $${paramIndex}`);
      params.push(targetId);
      paramIndex++;
    }

    if (since) {
      conditions.push(`a.created_at >= $${paramIndex}`);
      params.push(since);
      paramIndex++;
    }

    if (until) {
      conditions.push(`a.created_at <= $${paramIndex}`);
      params.push(until);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM audit_log a ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const dataParams = [...params, limit, offset];
    const dataResult = await query<{
      id: string;
      action: string;
      actor_id: string | null;
      actor_handle: string | null;
      target_id: string | null;
      meta: Record<string, unknown> | null;
      created_at: string;
    }>(
      `SELECT a.id, a.action, a.actor_id, u.handle as actor_handle, a.target_id, a.meta, a.created_at
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      dataParams
    );

    const entries = dataResult.rows.map(e => ({
      id: e.id,
      action: e.action,
      actorId: e.actor_id,
      actorHandle: e.actor_handle,
      targetId: e.target_id,
      meta: e.meta,
      createdAt: e.created_at,
    }));

    res.status(200).json({ entries, total, limit, offset });
  } catch (error) {
    console.error('Error listing audit log:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list audit log' });
  }
}
