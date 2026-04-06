import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { getVaultAuditLog } from '../vault/vault-store.js';

/**
 * Returns vault audit log entries for the authenticated user.
 */
export default async function vaultAuditLog(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const userDid = req.auth.did;
    const limitParam = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const limit = Math.max(1, Math.min(limitParam, 100));

    const entries = await getVaultAuditLog(userDid, limit);

    res.json({ entries });
  } catch (error) {
    console.error('Error fetching vault audit log:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to fetch vault audit log.' });
  }
}
