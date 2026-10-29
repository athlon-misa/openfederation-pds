import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { listMissingBlobs } from '../repo/blob-refs.js';
import { parsePagination } from '../xrpc/pagination.js';

/**
 * com.atproto.repo.listMissingBlobs — blobs the caller's own records
 * reference that this PDS holds no copy of. After importRepo (#262) these
 * are the blobs still to upload. Callable while deactivated, so a migration
 * client can use it before activation.
 */
export default async function listMissing(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (req.auth.authMethod === 'service-auth') {
    res.status(403).json({ error: 'Forbidden', message: 'Log in to the account to list its missing blobs' });
    return;
  }
  try {
    const { limit, cursor } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 1000 });
    const blobs = await listMissingBlobs(req.auth.did, { limit, cursor });
    res.status(200).json({ blobs, ...(blobs.length === limit ? { cursor: blobs[blobs.length - 1].cid } : {}) });
  } catch (error) {
    console.error('Error in listMissingBlobs');
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list missing blobs' });
  }
}
