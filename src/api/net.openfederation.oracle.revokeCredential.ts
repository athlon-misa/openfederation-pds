import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireRole } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

export default async function revokeOracleCredential(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireRole(req, res, ['admin'])) return;

    const { credentialId } = req.body || {};

    if (!credentialId) {
      res.status(400).json({ error: 'InvalidRequest', message: 'credentialId is required.' });
      return;
    }

    const result = await query<{ community_did: string }>(
      `UPDATE oracle_credentials SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'active' RETURNING community_did`,
      [credentialId]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Active credential not found.' });
      return;
    }

    await auditLog('oracle.credential.revoke', req.auth!.userId, result.rows[0].community_did, {
      credentialId,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error revoking Oracle credential:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to revoke credential.' });
  }
}
