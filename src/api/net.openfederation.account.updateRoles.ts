import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import type { UserRole } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

const VALID_ROLES: UserRole[] = ['admin', 'moderator', 'partner-manager', 'auditor', 'user'];

export default async function updateRoles(req: AuthRequest, res: Response): Promise<void> {
  if (!requireRole(req, res, ['admin'])) return;

  const { did, addRoles, removeRoles } = req.body;

  if (!did) {
    res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: did' });
    return;
  }

  const toAdd: string[] = Array.isArray(addRoles) ? addRoles : [];
  const toRemove: string[] = Array.isArray(removeRoles) ? removeRoles : [];

  if (toAdd.length === 0 && toRemove.length === 0) {
    res.status(400).json({ error: 'InvalidRequest', message: 'Provide addRoles and/or removeRoles' });
    return;
  }

  // Validate role names
  for (const r of [...toAdd, ...toRemove]) {
    if (!VALID_ROLES.includes(r as UserRole)) {
      res.status(400).json({ error: 'InvalidRequest', message: `Invalid role: ${r}. Valid roles: ${VALID_ROLES.join(', ')}` });
      return;
    }
  }

  try {
    // Find user
    const userResult = await query<{ id: string; did: string; handle: string }>(
      'SELECT id, did, handle FROM users WHERE did = $1',
      [did]
    );
    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'User not found' });
      return;
    }
    const user = userResult.rows[0];

    // Prevent removing own admin role (lockout protection)
    if (toRemove.includes('admin') && user.id === req.auth!.userId) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Cannot remove your own admin role' });
      return;
    }

    // If removing admin from someone, check there's at least one other admin
    if (toRemove.includes('admin')) {
      const adminCount = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM user_roles WHERE role = 'admin' AND user_id != $1`,
        [user.id]
      );
      if (parseInt(adminCount.rows[0].count, 10) === 0) {
        res.status(400).json({ error: 'InvalidRequest', message: 'Cannot remove the last admin' });
        return;
      }
    }

    // Add roles
    for (const r of toAdd) {
      await query(
        'INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [user.id, r]
      );
    }

    // Remove roles
    for (const r of toRemove) {
      await query(
        'DELETE FROM user_roles WHERE user_id = $1 AND role = $2',
        [user.id, r]
      );
    }

    // Fetch updated roles
    const rolesResult = await query<{ role: string }>(
      'SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role',
      [user.id]
    );
    const currentRoles = rolesResult.rows.map(r => r.role);

    await auditLog('account.roles.update', req.auth!.userId, user.id, {
      did: user.did,
      handle: user.handle,
      added: toAdd.length > 0 ? toAdd : undefined,
      removed: toRemove.length > 0 ? toRemove : undefined,
      currentRoles,
    });

    res.status(200).json({
      did: user.did,
      handle: user.handle,
      roles: currentRoles,
    });
  } catch (error) {
    console.error('Error updating roles:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to update roles' });
  }
}
