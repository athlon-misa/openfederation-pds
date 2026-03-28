import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRole } from '../auth/guards.js';
import { query } from '../db/client.js';

export default async function listExportSnapshots(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireRole(req, res, ['admin'])) return;

    const communityDid = req.query.communityDid as string;
    if (!communityDid) {
      res.status(400).json({ error: 'InvalidRequest', message: 'communityDid parameter required' });
      return;
    }

    const result = await query<any>(
      `SELECT * FROM export_snapshots WHERE community_did = $1 ORDER BY created_at DESC LIMIT 50`,
      [communityDid]
    );

    res.status(200).json({
      snapshots: result.rows.map(r => ({
        id: r.id, communityDid: r.community_did, storageKey: r.storage_key,
        sizeBytes: r.size_bytes, rootCid: r.root_cid, createdAt: r.created_at,
      })),
    });
  } catch (error) {
    console.error('Error in listExportSnapshots:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list export snapshots' });
  }
}
