import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';

export default async function listExportSchedules(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;

    const result = await query<any>(
      `SELECT es.*, c.handle FROM export_schedules es
       LEFT JOIN communities c ON c.did = es.community_did
       ORDER BY es.created_at DESC`
    );

    res.status(200).json({
      schedules: result.rows.map(r => ({
        id: r.id, communityDid: r.community_did, communityHandle: r.handle,
        interval: r.interval, retentionCount: r.retention_count, enabled: r.enabled,
        lastExportAt: r.last_export_at, lastStatus: r.last_status, lastError: r.last_error,
      })),
    });
  } catch (error) {
    console.error('Error in listExportSchedules:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list export schedules' });
  }
}
