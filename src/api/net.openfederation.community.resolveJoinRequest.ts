import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { resolveJoinRequestLifecycle } from '../community/membership.js';
import { renderXrpcError } from '../xrpc/errors.js';

const NSID = 'net.openfederation.community.resolveJoinRequest';

/**
 * net.openfederation.community.resolveJoinRequest
 *
 * Approve or reject a pending join request. Owner or admin only.
 */
export default async function resolveJoinRequest(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const result = await resolveJoinRequestLifecycle(req.auth, req.body ?? {});
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
