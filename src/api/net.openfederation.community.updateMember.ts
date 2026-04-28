import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { updateMemberLifecycle } from '../community/membership/update.js';
import { renderXrpcError } from '../xrpc/errors.js';
import type { NetOpenfederationCommunityUpdateMemberOutput } from '../lexicon/generated.js';

const NSID = 'net.openfederation.community.updateMember';

/**
 * Partial update for community member records. Replaces updateMemberRole.
 */
export default async function updateMember(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const result: NetOpenfederationCommunityUpdateMemberOutput = await updateMemberLifecycle(req.auth, req.body ?? {});
    res.status(200).json(result);
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
