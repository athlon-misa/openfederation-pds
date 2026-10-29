import { Request, Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRepoReadable } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { listReferencedBlobs } from '../repo/blob-refs.js';
import { parsePagination } from '../xrpc/pagination.js';

/**
 * com.atproto.sync.listBlobs — the blob CIDs a repository's records
 * reference, in CID order. Account migration (#264) uses it on the old PDS
 * to learn which blobs to copy. Gated like getRepo, since a blob CID is the
 * capability to read the blob. `since` is accepted and ignored: the full
 * list is a superset of what changed since any revision.
 */
export default async function listBlobs(req: Request, res: Response): Promise<void> {
  try {
    const did = String(req.query.did || '');
    if (!did || !did.startsWith('did:')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing or invalid required parameter: did' });
      return;
    }
    if (!(await requireRepoReadable(req as AuthRequest, res, did))) return;
    if (!(await new RepoEngine(did).hasRepo())) {
      res.status(404).json({ error: 'RepoNotFound', message: `Repository not found for DID: ${did}` });
      return;
    }

    const { limit, cursor } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 1000 });
    const cids = await listReferencedBlobs(did, { limit, cursor });
    res.status(200).json({ cids, ...(cids.length === limit ? { cursor: cids[cids.length - 1] } : {}) });
  } catch (error) {
    console.error('Error in sync.listBlobs:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list blobs' });
  }
}
