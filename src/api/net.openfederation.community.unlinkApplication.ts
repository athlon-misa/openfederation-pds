import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, requireApprovedUser, requireActiveCommunity, requireCommunityRole } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';

const COLLECTION = 'net.openfederation.community.application';

/**
 * net.openfederation.community.unlinkApplication
 *
 * Remove a linked application from a community.
 * Deletes the repo record from the community's MST repository.
 * Only community owner or PDS admin can unlink applications.
 */
export default async function unlinkApplication(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireApprovedUser(req, res)) return;

    const { communityDid, rkey } = req.body;

    if (!communityDid || !rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, rkey',
      });
      return;
    }

    // Ensure community is active
    const community = await requireActiveCommunity(communityDid, res);
    if (!community) return;

    // Require owner role
    const role = await requireCommunityRole(req, res, communityDid, ['owner']);
    if (!role) return;

    const engine = new RepoEngine(communityDid);

    // Verify record exists
    const existing = await engine.getRecord(COLLECTION, rkey);
    if (!existing) {
      res.status(404).json({
        error: 'NotFound',
        message: 'Application record not found',
      });
      return;
    }

    // Delete from repo
    const keypair = await getKeypairForDid(communityDid);
    await engine.deleteRecord(keypair, COLLECTION, rkey);

    await auditLog('community.unlinkApplication', req.auth!.userId, communityDid, {
      rkey,
      appType: (existing.record as { appType?: string }).appType,
      instanceUrl: (existing.record as { instanceUrl?: string }).instanceUrl,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error unlinking application:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to unlink application' });
  }
}
