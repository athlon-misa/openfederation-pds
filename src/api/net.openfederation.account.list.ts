import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';

export default async function listAccounts(req: AuthRequest, res: Response): Promise<void> {
  if (!requireRole(req, res, ['admin', 'moderator', 'auditor'])) {
    return;
  }

  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const status = req.query.status ? String(req.query.status) : undefined;
  const role = req.query.role ? String(req.query.role) : undefined;
  const q = req.query.q ? String(req.query.q) : undefined;

  const validStatuses = ['pending', 'approved', 'rejected', 'disabled'];
  if (status && !validStatuses.includes(status)) {
    res.status(400).json({ error: 'InvalidRequest', message: 'Invalid status filter' });
    return;
  }

  const validRoles = ['admin', 'moderator', 'partner-manager', 'auditor', 'user'];
  if (role && !validRoles.includes(role)) {
    res.status(400).json({ error: 'InvalidRequest', message: 'Invalid role filter' });
    return;
  }

  try {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`u.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (role) {
      conditions.push(`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = $${paramIndex})`);
      params.push(role);
      paramIndex++;
    }

    if (q) {
      conditions.push(`(u.handle ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex})`);
      params.push(`%${q}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM users u ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const dataParams = [...params, limit, offset];
    const dataResult = await query<{
      id: string;
      handle: string;
      email: string;
      did: string;
      status: string;
      created_at: string;
      approved_at: string | null;
    }>(
      `SELECT u.id, u.handle, u.email, u.did, u.status, u.created_at, u.approved_at
       FROM users u
       ${whereClause}
       ORDER BY u.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      dataParams
    );

    // Fetch roles for all returned users in one query
    const userIds = dataResult.rows.map(u => u.id);
    let rolesMap: Record<string, string[]> = {};
    if (userIds.length > 0) {
      const rolesResult = await query<{ user_id: string; role: string }>(
        `SELECT user_id, role FROM user_roles WHERE user_id = ANY($1)`,
        [userIds]
      );
      for (const row of rolesResult.rows) {
        if (!rolesMap[row.user_id]) rolesMap[row.user_id] = [];
        rolesMap[row.user_id].push(row.role);
      }
    }

    const users = dataResult.rows.map(u => ({
      id: u.id,
      handle: u.handle,
      email: u.email,
      did: u.did,
      status: u.status,
      roles: rolesMap[u.id] || [],
      createdAt: u.created_at,
      approvedAt: u.approved_at,
    }));

    res.status(200).json({ users, total, limit, offset });
  } catch (error) {
    console.error('Error listing accounts:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list accounts' });
  }
}
