import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

export default async function deleteExportSchedule(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;

    const { communityDid } = req.body;
    if (!communityDid) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing: communityDid' });
      return;
    }

    const result = await query('DELETE FROM export_schedules WHERE community_did = $1 RETURNING id', [communityDid]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'No export schedule found for this community' });
      return;
    }

    await auditLog('admin.export.schedule.delete', req.auth!.userId, communityDid, {});
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in deleteExportSchedule:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to delete export schedule' });
  }
}
