import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireApprovedUser, requireActiveCommunity, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';

const ALLOWED_APP_TYPES = ['mastodon', 'matrix', 'discourse', 'custom'] as const;
const COLLECTION = 'net.openfederation.community.application';

/**
 * net.openfederation.community.linkApplication
 *
 * Link an external application (Mastodon, Matrix, etc.) to a community.
 * Creates a repo record in the community's MST repository.
 * Only community owner or PDS admin can link applications.
 */
export default async function linkApplication(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    if (!requireApprovedUser(req, res)) return;

    const { communityDid, appType, instanceUrl, displayName } = req.body;

    if (!communityDid || !appType || !instanceUrl) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: communityDid, appType, instanceUrl',
      });
      return;
    }

    // Validate appType
    if (!ALLOWED_APP_TYPES.includes(appType)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: `Invalid appType. Must be one of: ${ALLOWED_APP_TYPES.join(', ')}`,
      });
      return;
    }

    // Validate instanceUrl is a valid HTTPS URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(instanceUrl);
      if (parsedUrl.protocol !== 'https:') {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'instanceUrl must use HTTPS',
        });
        return;
      }
    } catch {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'instanceUrl must be a valid URL',
      });
      return;
    }

    // Ensure community is active
    const community = await requireActiveCommunity(communityDid, res);
    if (!community) return;

    // Require owner role
    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext },
      res, communityDid, 'community.application.write'
    );
    if (!hasPermission) return;

    const engine = new RepoEngine(communityDid);

    // Check for duplicate: same instanceUrl already linked
    const existing = await engine.listRecords(COLLECTION, 100);
    const duplicate = existing.records.find(
      (r) => (r.record as { instanceUrl?: string }).instanceUrl === instanceUrl,
    );
    if (duplicate) {
      res.status(409).json({
        error: 'Conflict',
        message: 'This instance URL is already linked to this community',
      });
      return;
    }

    // Build the record
    const rkey = RepoEngine.generateTid();
    const record = {
      $type: COLLECTION,
      appType,
      instanceUrl: parsedUrl.toString(),
      displayName: displayName || undefined,
      linkedAt: new Date().toISOString(),
      linkedBy: req.auth!.did,
    };

    // Write to repo
    const keypair = await getKeypairForDid(communityDid);
    const { uri } = await engine.putRecord(keypair, COLLECTION, rkey, record);

    await auditLog('community.linkApplication', req.auth!.userId, communityDid, {
      appType,
      instanceUrl: parsedUrl.toString(),
      rkey,
    });

    res.status(200).json({
      uri,
      rkey,
      appType,
      instanceUrl: parsedUrl.toString(),
      displayName: displayName || null,
    });
  } catch (error) {
    console.error('Error linking application:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to link application' });
  }
}
