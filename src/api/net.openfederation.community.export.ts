import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { auditLog } from '../db/audit.js';

/**
 * net.openfederation.community.export
 *
 * Export all community data as a JSON archive. Implements the AT Protocol
 * "free to go" principle — community owners and PDS admins can always
 * export a full copy of the community's repository.
 *
 * Returns: JSON with community metadata, settings, profile, and all records.
 */
export default async function exportCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const did = String(req.query.did || req.body?.did || '');
    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required param: did' });
      return;
    }

    // Fetch community
    const communityResult = await query<{
      did: string;
      handle: string;
      did_method: string;
      created_by: string;
      status: string;
    }>(
      'SELECT did, handle, did_method, created_by, status FROM communities WHERE did = $1',
      [did]
    );

    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    const community = communityResult.rows[0];

    // Authorization: owner or PDS admin
    const isOwner = community.created_by === req.auth!.userId;
    const isAdmin = req.auth!.roles.includes('admin');

    if (!isOwner && !isAdmin) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only the community owner or PDS admin can export community data',
      });
      return;
    }

    // Export all records
    const engine = new RepoEngine(did);
    const records = await engine.exportAllRecords();

    // Group records by collection
    const collections: Record<string, Array<{ rkey: string; cid: string; record: any }>> = {};
    for (const r of records) {
      if (!collections[r.collection]) {
        collections[r.collection] = [];
      }
      collections[r.collection].push({ rkey: r.rkey, cid: r.cid, record: r.record });
    }

    // Get member count
    const memberCount = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM members_unique WHERE community_did = $1',
      [did]
    );

    // Mark export timestamp on community
    await query(
      'UPDATE communities SET exported_at = CURRENT_TIMESTAMP WHERE did = $1',
      [did]
    );

    await auditLog('community.export', req.auth!.userId, did, {
      recordCount: records.length,
      collections: Object.keys(collections),
    });

    const exportData = {
      $type: 'net.openfederation.community.export',
      exportedAt: new Date().toISOString(),
      exportedBy: req.auth!.did,
      community: {
        did: community.did,
        handle: community.handle,
        didMethod: community.did_method,
        status: community.status,
      },
      stats: {
        totalRecords: records.length,
        memberCount: parseInt(memberCount.rows[0].count, 10),
        collections: Object.keys(collections).length,
      },
      collections,
    };

    res.status(200).json(exportData);
  } catch (error) {
    console.error('Error exporting community:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to export community' });
  }
}
