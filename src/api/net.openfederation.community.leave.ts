import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { leaveCommunityLifecycle } from '../community/membership.js';
import { renderXrpcError } from '../xrpc/errors.js';

const NSID = 'net.openfederation.community.leave';

/**
 * net.openfederation.community.leave
 *
 * Leave a community. Owner cannot leave.
 */
export default async function leaveCommunity(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const result = await leaveCommunityLifecycle(req.auth, req.body ?? {});
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
