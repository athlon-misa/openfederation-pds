import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { removeMemberLifecycle } from '../community/membership/remove.js';
import { renderXrpcError } from '../xrpc/errors.js';

const NSID = 'net.openfederation.community.removeMember';

/**
 * net.openfederation.community.removeMember
 *
 * Remove (kick) a member from a community.
 * Only the community owner or PDS admin can remove members.
 * The owner cannot be removed.
 */
export default async function removeMember(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const result = await removeMemberLifecycle(req.auth, req.body ?? {});
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
