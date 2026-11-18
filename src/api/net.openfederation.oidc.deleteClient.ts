import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { deleteClient } from '../oidc/clients.js';

/** net.openfederation.oidc.deleteClient — the app can no longer sign anyone in (ADR-005). */
export default async function deleteOidcClient(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
    if (!clientId) {
      res.status(400).json({ error: 'InvalidRequest', message: 'clientId is required' });
      return;
    }
    if (!(await deleteClient(clientId))) {
      res.status(404).json({ error: 'NotFound', message: 'No such client' });
      return;
    }
    await auditLog('oidc.client.delete', req.auth!.userId, clientId, {});
    res.json({ deleted: true });
  } catch (err) {
    console.error('Error deleting OIDC client:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to delete the client' });
  }
}
