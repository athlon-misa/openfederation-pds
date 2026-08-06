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

const NSID = 'com.atproto.repo.putRecord';

/**
 * com.atproto.repo.putRecord
 *
 * Create or update a record in a repository. Requires auth.
 * The caller must have write access to the repo (owner or PDS admin).
 */
export default async function putRecord(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { repo, collection, rkey, record } = req.body;

    if (!repo || !collection || !rkey || !record) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: repo, collection, rkey, record',
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
      operation: 'update',
    });

    // Authority attributed to this request by a registered module, if any.
    const requestContext = resolveGovernanceContext(req);
    let governance: GovernanceResult | null = null;

    // Governance enforcement for community repos
    if (await isCommunityDid(repo)) {
      governance = await enforceGovernance(repo, collection, 'write', requestContext);
      if (!governance.allowed) {
        res.status(403).json({
          error: 'GovernanceDenied',
          message: governance.reason || 'Write blocked by governance policy',
          ...(governance.requiresProposal ? { requiresProposal: true } : {}),
        });
        return;
      }
    }

    const engine = new RepoEngine(repo);
    const keypair = await getKeypairForDid(repo);

    const result = await runGovernedMutation({
      request: req,
      context: requestContext,
      governance,
      communityDid: repo,
      collection,
      rkey,
      action: 'write',
      operation: 'put',
      record,
      mutate: () => engine.putRecord(keypair, collection, rkey, record),
    });

    res.status(200).json({
      uri: result.uri,
      cid: result.cid,
    });
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
