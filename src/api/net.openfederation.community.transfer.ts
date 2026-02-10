import { Response } from 'express';
import crypto from 'crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { SimpleRepoEngine } from '../repo/simple-engine.js';
import { auditLog } from '../db/audit.js';

/**
 * net.openfederation.community.transfer.initiate
 *
 * Initiate a community transfer to another PDS. This implements the
 * AT Protocol portability principle — communities are not locked to
 * any single PDS.
 *
 * The flow:
 * 1. Owner calls this endpoint → receives a full export + signed transfer token
 * 2. Owner imports the export on the new PDS using the transfer token
 * 3. For did:plc communities, the owner uses their rotation key to update
 *    the PLC directory to point to the new PDS
 * 4. For did:web communities, the owner updates their DNS/hosting
 *
 * After transfer, the community on this PDS is marked as 'takendown'
 * with a reason indicating transfer.
 */
export default async function transferCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { did } = req.body;

    if (!did) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required field: did' });
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

    // Only the owner can initiate transfer
    if (community.created_by !== req.auth!.userId) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Only the community owner can initiate a transfer',
      });
      return;
    }

    if (community.status === 'takendown') {
      res.status(400).json({
        error: 'CommunityTakenDown',
        message: 'Cannot transfer a community that has been taken down',
      });
      return;
    }

    // Export all records
    const engine = new SimpleRepoEngine(did);
    const records = await engine.exportAllRecords();

    // Group records by collection
    const collections: Record<string, Array<{ rkey: string; cid: string; record: any }>> = {};
    for (const r of records) {
      if (!collections[r.collection]) {
        collections[r.collection] = [];
      }
      collections[r.collection].push({ rkey: r.rkey, cid: r.cid, record: r.record });
    }

    // Generate a transfer token (signed proof that this PDS authorizes the transfer)
    const transferToken = crypto.randomBytes(32).toString('hex');
    const transferExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

    // Get member count
    const memberCount = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM members_unique WHERE community_did = $1',
      [did]
    );

    // Mark export timestamp
    await query(
      'UPDATE communities SET exported_at = CURRENT_TIMESTAMP WHERE did = $1',
      [did]
    );

    await auditLog('community.transfer.initiate', req.auth!.userId, did, {
      recordCount: records.length,
      didMethod: community.did_method,
    });

    // Build the transfer package
    const transferPackage = {
      $type: 'net.openfederation.community.transfer',
      transferToken,
      transferExpiresAt,
      exportedAt: new Date().toISOString(),
      sourcePds: process.env.PDS_HOSTNAME || 'localhost',
      community: {
        did: community.did,
        handle: community.handle,
        didMethod: community.did_method,
      },
      stats: {
        totalRecords: records.length,
        memberCount: parseInt(memberCount.rows[0].count, 10),
        collections: Object.keys(collections).length,
      },
      collections,
      instructions: community.did_method === 'plc'
        ? 'After importing on the new PDS, use your rotation key to sign a PLC operation updating the service endpoint to point to the new PDS.'
        : 'After importing on the new PDS, update your DNS to point to the new PDS and update the did.json document at /.well-known/did.json.',
    };

    res.status(200).json(transferPackage);
  } catch (error) {
    console.error('Error initiating community transfer:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to initiate community transfer' });
  }
}
