import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { authorizeCollectionMutation } from '../repo/collection-policy.js';
import { enforceGovernance, isCommunityDid, type GovernanceResult } from '../governance/enforcement.js';
import { resolveGovernanceContext, runGovernedMutation } from '../governance/request-authority.js';
import { FORUM_THREAD, FORUM_POST, CALENDAR_EVENT, CALENDAR_RSVP } from '../forum/forum-index.js';
import { renderXrpcError } from '../xrpc/errors.js';

const NSID = 'com.atproto.repo.deleteRecord';

/**
 * com.atproto.repo.deleteRecord
 *
 * Delete a record from a repository. Requires auth and write permission.
 */
export default async function deleteRecord(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { repo, collection, rkey } = req.body;

    if (!repo || !collection || !rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: repo, collection, rkey',
      });
      return;
    }

    if (typeof repo !== 'string' || !repo.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'repo must be a valid DID',
      });
      return;
    }

    const DEDICATED = [FORUM_THREAD, FORUM_POST, CALENDAR_EVENT, CALENDAR_RSVP];
    if (DEDICATED.includes(collection)) {
      res.status(400).json({
        error: 'UseDedicatedEndpoint',
        message: `Records in "${collection}" must be written via their net.openfederation.forum.* / net.openfederation.calendar.* endpoint.`,
      });
      return;
    }

    await authorizeCollectionMutation({
      actor: req.auth!,
      repo,
      collection,
      operation: 'delete',
    });

    // Authority attributed to this request by a registered module, if any.
    const requestContext = resolveGovernanceContext(req);
    let governance: GovernanceResult | null = null;

    // Governance enforcement for community repos
    if (await isCommunityDid(repo)) {
      governance = await enforceGovernance(repo, collection, 'delete', requestContext);
      if (!governance.allowed) {
        res.status(403).json({
          error: 'GovernanceDenied',
          message: governance.reason || 'Delete blocked by governance policy',
          ...(governance.requiresProposal ? { requiresProposal: true } : {}),
        });
        return;
      }
    }

    const engine = new RepoEngine(repo);
    const keypair = await getKeypairForDid(repo);

    await runGovernedMutation({
      request: req,
      context: requestContext,
      governance,
      communityDid: repo,
      collection,
      rkey,
      action: 'delete',
      operation: 'delete',
      mutate: () => engine.deleteRecord(keypair, collection, rkey),
    });

    res.status(200).json({});
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
