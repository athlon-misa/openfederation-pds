import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';

const VALID_MODELS = ['benevolent-dictator', 'simple-majority', 'on-chain'];

export default async function setGovernanceModel(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, governanceModel, governanceConfig } = req.body;

    if (!communityDid || !governanceModel) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: communityDid, governanceModel' });
      return;
    }

    if (!VALID_MODELS.includes(governanceModel)) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: `governanceModel must be one of: ${VALID_MODELS.join(', ')}`,
      });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.settings.write'
    );
    if (!hasPermission) return;

    if (governanceModel === 'simple-majority') {
      if (!governanceConfig || typeof governanceConfig !== 'object') {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'governanceConfig is required for simple-majority (quorum, voterRole)',
        });
        return;
      }
      if (!governanceConfig.quorum || typeof governanceConfig.quorum !== 'number' || governanceConfig.quorum < 1) {
        res.status(400).json({ error: 'InvalidRequest', message: 'governanceConfig.quorum must be a positive integer' });
        return;
      }
      if (!governanceConfig.voterRole || typeof governanceConfig.voterRole !== 'string') {
        res.status(400).json({ error: 'InvalidRequest', message: 'governanceConfig.voterRole is required' });
        return;
      }

      // Validate protectedCollections if provided
      if (governanceConfig.protectedCollections) {
        if (!Array.isArray(governanceConfig.protectedCollections)) {
          res.status(400).json({ error: 'InvalidRequest', message: 'protectedCollections must be an array' });
          return;
        }
        const mandatory = ['net.openfederation.community.settings', 'net.openfederation.community.role'];
        const normalized = governanceConfig.protectedCollections.map((c: string) =>
          c.startsWith('net.openfederation.community.') ? c : `net.openfederation.community.${c}`
        );
        for (const m of mandatory) {
          if (!normalized.includes(m)) {
            normalized.push(m);
          }
        }
        governanceConfig.protectedCollections = normalized;
      }
    }

    if (governanceModel === 'on-chain') {
      if (!governanceConfig || typeof governanceConfig !== 'object') {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'governanceConfig is required for on-chain (chainId, contractAddress)',
        });
        return;
      }
      if (!governanceConfig.chainId || typeof governanceConfig.chainId !== 'string') {
        res.status(400).json({ error: 'InvalidRequest', message: 'governanceConfig.chainId is required' });
        return;
      }
      if (!governanceConfig.contractAddress || typeof governanceConfig.contractAddress !== 'string') {
        res.status(400).json({ error: 'InvalidRequest', message: 'governanceConfig.contractAddress is required' });
        return;
      }

      // Verify an active Oracle credential exists for this community
      const oracleResult = await query(
        `SELECT 1 FROM oracle_credentials WHERE community_did = $1 AND status = 'active'`,
        [communityDid]
      );
      if (oracleResult.rows.length === 0) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'An active Oracle credential must exist for this community before enabling on-chain governance. Create one first.',
        });
        return;
      }

      // Normalize protectedCollections (same logic as simple-majority)
      if (governanceConfig.protectedCollections) {
        if (!Array.isArray(governanceConfig.protectedCollections)) {
          res.status(400).json({ error: 'InvalidRequest', message: 'protectedCollections must be an array' });
          return;
        }
        const mandatory = ['net.openfederation.community.settings', 'net.openfederation.community.role'];
        const normalized = governanceConfig.protectedCollections.map((c: string) =>
          c.startsWith('net.openfederation.community.') ? c : `net.openfederation.community.${c}`
        );
        for (const m of mandatory) {
          if (!normalized.includes(m)) normalized.push(m);
        }
        governanceConfig.protectedCollections = normalized;
      }
    }

    const settingsResult = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
      [communityDid]
    );

    if (settingsResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community settings not found' });
      return;
    }

    const currentSettings = settingsResult.rows[0].record;
    const currentModel = currentSettings.governanceModel || 'benevolent-dictator';

    if (currentModel === 'on-chain') {
      res.status(403).json({
        error: 'GovernanceDowngradeBlocked',
        message: 'Cannot downgrade from on-chain governance without PDS admin override.',
      });
      return;
    }

    const engine = new RepoEngine(communityDid);
    const keypair = await getKeypairForDid(communityDid);

    const updatedSettings = {
      ...currentSettings,
      governanceModel,
      ...(governanceConfig ? { governanceConfig } : {}),
    };

    await engine.putRecord(keypair, 'net.openfederation.community.settings', 'self', updatedSettings);

    await auditLog('community.governance.setModel', req.auth!.userId, communityDid, {
      previousModel: currentModel,
      newModel: governanceModel,
    });

    res.status(200).json({ success: true, governanceModel });
  } catch (error) {
    console.error('Error in setGovernanceModel:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to set governance model' });
  }
}
