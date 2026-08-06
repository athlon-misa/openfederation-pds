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
import { SETTINGS_COLLECTION, checkGovernanceSettings } from '../governance/settings-rules.js';

export default async function setGovernanceModel(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { communityDid, governanceModel, governanceConfig } = req.body;

    if (!communityDid || !governanceModel) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing required fields: communityDid, governanceModel' });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.settings.write'
    );
    if (!hasPermission) return;

    // The same predicate the proposal route applies (`checkGovernanceSettings`
    // in governance/settings-rules.ts). Neither route may be the lenient one:
    // whichever is, becomes the way to give a community a governance model
    // nothing recognizes.
    const invalid = checkGovernanceSettings({ governanceModel, governanceConfig }, { normalize: true });
    if (invalid) {
      res.status(400).json({ error: 'InvalidRequest', message: invalid.message });
      return;
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
