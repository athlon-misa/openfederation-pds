import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { auditLog } from '../db/audit.js';

/**
 * net.openfederation.account.export
 *
 * Export all user repo data as a JSON archive. Implements the AT Protocol
 * "free to go" principle — users can always export their own data, and
 * PDS admins can export on behalf of any user.
 *
 * Sets the exported_at timestamp, which is required before admin takedown.
 */
export default async function exportAccount(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const did = String(req.query.did || req.body?.did || '');
    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required param: did' });
      return;
    }

    // Fetch user
    const userResult = await query<{
      id: string;
      did: string;
      handle: string;
      email: string;
      status: string;
      created_at: string;
    }>(
      'SELECT id, did, handle, email, status, created_at FROM users WHERE did = $1',
      [did]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Account not found' });
      return;
    }

    const user = userResult.rows[0];

    // Authorization: self or PDS admin
    const isSelf = user.id === req.auth!.userId;
    const isAdmin = req.auth!.roles.includes('admin');

    if (!isSelf && !isAdmin) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only the account owner or PDS admin can export account data',
      });
      return;
    }

    // Export all records from user repo
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

    // Get community memberships
    const memberships = await query<{ community_did: string }>(
      'SELECT community_did FROM members_unique WHERE member_did = $1',
      [did]
    );

    // Mark export timestamp
    await query(
      'UPDATE users SET exported_at = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    await auditLog('account.export', req.auth!.userId, user.id, {
      did,
      recordCount: records.length,
      collections: Object.keys(collections),
    });

    const exportData = {
      $type: 'net.openfederation.account.export',
      exportedAt: new Date().toISOString(),
      exportedBy: req.auth!.did,
      account: {
        did: user.did,
        handle: user.handle,
        email: isSelf ? user.email : undefined, // Only include email for self-export
        status: user.status,
        createdAt: user.created_at,
      },
      stats: {
        totalRecords: records.length,
        collections: Object.keys(collections).length,
        communityMemberships: memberships.rows.length,
      },
      memberships: memberships.rows.map(m => m.community_did),
      collections,
    };

    res.status(200).json(exportData);
  } catch (error) {
    console.error('Error exporting account:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to export account' });
  }
}
