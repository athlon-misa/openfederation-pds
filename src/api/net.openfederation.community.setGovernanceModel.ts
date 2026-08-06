/**
 * Switch a community's governance model (#198).
 *
 * This endpoint used to hold a ratchet: once a community was `on-chain` it
 * could not leave without "a PDS admin override" (`GovernanceDowngradeBlocked`).
 * That encoded the belief the rest of this refactor removes — that a chain-
 * backed community is a privileged tier whose members can be locked into it,
 * and that a PDS operator is the authority who lets them out.
 *
 * There is no tier and no override. `governanceModel` is a field on
 * `net.openfederation.community.settings`, which is a MANDATORY_PROTECTED
 * collection, so changing it is exactly as governed as any other change to that
 * record: free under `benevolent-dictator`, and a proposal plus a quorum under
 * every model that requires one — including the model change that would leave
 * that model. A community can adopt anchoring, and can drop it again, by the
 * same route it decides anything else.
 *
 * So the enforcement call below is not a formality: it is the only thing that
 * used to be missing here. Before it, an owner with `community.settings.write`
 * could rewrite the governance model of a simple-majority community directly,
 * which made the ratchet the *only* constraint on model changes and made it a
 * constraint in the wrong direction.
 */

import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { auditLog } from '../db/audit.js';
import { query } from '../db/client.js';
import { enforceGovernance, type GovernanceResult } from '../governance/enforcement.js';
import { resolveGovernanceContext, runGovernedMutation } from '../governance/request-authority.js';

const VALID_MODELS = ['benevolent-dictator', 'simple-majority', 'on-chain'];

const SETTINGS_COLLECTION = 'net.openfederation.community.settings';
const MANDATORY_PROTECTED = [SETTINGS_COLLECTION, 'net.openfederation.community.role'];

/** Models whose changes to protected collections are decided by vote records. */
const VOTED_MODELS = ['simple-majority', 'on-chain'];

type Invalid = { message: string };

/**
 * Validation shared by every model that resolves proposals from vote records.
 * `on-chain` is that same governance plus anchoring, so it answers to the same
 * rules rather than to a parallel set of its own.
 */
function checkVotingConfig(governanceConfig: any, requireQuorum: boolean): Invalid | null {
  if (requireQuorum) {
    if (!governanceConfig.quorum || typeof governanceConfig.quorum !== 'number' || governanceConfig.quorum < 1) {
      return { message: 'governanceConfig.quorum must be a positive integer' };
    }
    if (!governanceConfig.voterRole || typeof governanceConfig.voterRole !== 'string') {
      return { message: 'governanceConfig.voterRole is required' };
    }
  } else {
    if (governanceConfig.quorum !== undefined
      && (typeof governanceConfig.quorum !== 'number' || governanceConfig.quorum < 1)) {
      return { message: 'governanceConfig.quorum must be a positive integer' };
    }
  }

  // The contest window a passed proposal waits out before its change is
  // applied. Optional: absent means the default (see `timelockHours` in
  // decision-rules.ts). Instant application has to be asked for by name.
  if (governanceConfig.timelockHours !== undefined) {
    const hours = governanceConfig.timelockHours;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) {
      return {
        message: 'governanceConfig.timelockHours must be a non-negative number of hours (0 applies changes immediately)',
      };
    }
  }

  if (governanceConfig.protectedCollections !== undefined) {
    if (!Array.isArray(governanceConfig.protectedCollections)) {
      return { message: 'protectedCollections must be an array' };
    }
    const normalized = governanceConfig.protectedCollections.map((c: string) =>
      c.startsWith('net.openfederation.community.') ? c : `net.openfederation.community.${c}`
    );
    for (const m of MANDATORY_PROTECTED) {
      if (!normalized.includes(m)) normalized.push(m);
    }
    governanceConfig.protectedCollections = normalized;
  }

  return null;
}

/**
 * Anchoring is a plain setting, not a mode. It says which notary to publish
 * decisions to, never who decides them.
 */
function checkAnchoring(governanceConfig: any): Invalid | null {
  const anchoring = governanceConfig.anchoring;
  if (anchoring === undefined) return null;
  if (!anchoring || typeof anchoring !== 'object' || Array.isArray(anchoring)) {
    return { message: 'governanceConfig.anchoring must be an object with { enabled, chainId }' };
  }
  if (typeof anchoring.enabled !== 'boolean') {
    return { message: 'governanceConfig.anchoring.enabled must be a boolean' };
  }
  if (anchoring.chainId !== undefined && typeof anchoring.chainId !== 'string') {
    return { message: 'governanceConfig.anchoring.chainId must be a CAIP-2 chain id string' };
  }
  if (anchoring.enabled && !anchoring.chainId && typeof governanceConfig.chainId !== 'string') {
    return { message: 'governanceConfig.anchoring.chainId is required when anchoring is enabled' };
  }
  return null;
}

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

    if (VOTED_MODELS.includes(governanceModel)) {
      if (!governanceConfig || typeof governanceConfig !== 'object') {
        res.status(400).json({
          error: 'InvalidRequest',
          message: governanceModel === 'simple-majority'
            ? 'governanceConfig is required for simple-majority (quorum, voterRole)'
            : 'governanceConfig is required for on-chain (chainId, and the quorum config governance runs on)',
        });
        return;
      }

      // `simple-majority` has always had to state its quorum. `on-chain` did
      // not, because it did not use one; it does now, so an unstated quorum
      // falls back to the same default resolution applies (DEFAULT_QUORUM)
      // rather than breaking communities configured under the old meaning.
      const invalid = checkVotingConfig(governanceConfig, governanceModel === 'simple-majority');
      if (invalid) {
        res.status(400).json({ error: 'InvalidRequest', message: invalid.message });
        return;
      }
    }

    if (governanceModel === 'on-chain') {
      // The one thing `on-chain` still needs: somewhere to anchor. Not an
      // Oracle credential — an Oracle is a way of carrying authority into a
      // request, not a precondition for a community deciding its own affairs.
      if (!governanceConfig.chainId || typeof governanceConfig.chainId !== 'string') {
        res.status(400).json({ error: 'InvalidRequest', message: 'governanceConfig.chainId is required' });
        return;
      }
    }

    if (governanceConfig && typeof governanceConfig === 'object') {
      const invalid = checkAnchoring(governanceConfig);
      if (invalid) {
        res.status(400).json({ error: 'InvalidRequest', message: invalid.message });
        return;
      }
    }

    const settingsResult = await query<{ record: any }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = $2 AND rkey = 'self'`,
      [communityDid, SETTINGS_COLLECTION]
    );

    if (settingsResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community settings not found' });
      return;
    }

    const currentSettings = settingsResult.rows[0].record;
    const currentModel = currentSettings.governanceModel || 'benevolent-dictator';

    // The settings record is protected, so the community's *current* model
    // decides who may rewrite it — including to change that model. No ratchet,
    // no override: a community under a voting model leaves it the same way it
    // does anything else, by proposing and passing the change.
    const requestContext = resolveGovernanceContext(req);
    const governance: GovernanceResult = await enforceGovernance(
      communityDid, SETTINGS_COLLECTION, 'write', requestContext,
    );
    if (!governance.allowed) {
      res.status(403).json({
        error: 'GovernanceDenied',
        message: governance.reason || 'Governance model change blocked by governance policy',
        ...(governance.requiresProposal ? { requiresProposal: true } : {}),
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

    await runGovernedMutation({
      request: req,
      context: requestContext,
      governance,
      communityDid,
      collection: SETTINGS_COLLECTION,
      rkey: 'self',
      action: 'write',
      operation: 'put',
      record: updatedSettings,
      mutate: () => engine.putRecord(keypair, SETTINGS_COLLECTION, 'self', updatedSettings),
    });

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
