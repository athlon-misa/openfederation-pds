import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireApprovedUser } from '../auth/guards.js';
import { renderXrpcError } from '../xrpc/errors.js';
import { joinCommunityLifecycle } from '../community/membership.js';
import type { NetOpenfederationCommunityJoinOutput } from '../lexicon/generated.js';

const NSID = 'net.openfederation.community.join';

/**
 * net.openfederation.community.join
 *
 * Join a community (open) or request to join (approval policy).
 * Optional semantic fields (kind / tags / attributes) classify the
 * membership — see issue #50. Consuming apps own the vocabulary; the
 * PDS only enforces size bounds so one membership record can't balloon
 * community storage.
 */
export default async function joinCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireApprovedUser(req, res)) {
      return;
    }

    const auth = req.auth!;
    const result: NetOpenfederationCommunityJoinOutput = await joinCommunityLifecycle(auth, req.body ?? {});
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
