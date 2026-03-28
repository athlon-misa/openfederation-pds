import { Response } from 'express';
import { randomUUID } from 'crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

const VALID_INTERVALS = ['daily', 'weekly', 'monthly'];

export default async function createExportSchedule(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;

    const { communityDid, interval, retentionCount } = req.body;

    if (!communityDid || !interval) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing: communityDid, interval' });
      return;
    }

    if (!VALID_INTERVALS.includes(interval)) {
      res.status(400).json({ error: 'InvalidRequest', message: `interval must be: ${VALID_INTERVALS.join(', ')}` });
      return;
    }

    const retention = retentionCount || 5;
    const id = randomUUID();

    await query(
      `INSERT INTO export_schedules (id, community_did, interval, retention_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community_did) DO UPDATE SET interval = $3, retention_count = $4, enabled = true`,
      [id, communityDid, interval, retention]
    );

    await auditLog('admin.export.schedule.create', req.auth!.userId, communityDid, { interval, retention });

    res.status(200).json({ id, communityDid, interval, retentionCount: retention });
  } catch (error) {
    console.error('Error in createExportSchedule:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create export schedule' });
  }
}
