import { Request, Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRepoReadable } from '../auth/guards.js';
import { query } from '../db/client.js';

/**
 * com.atproto.sync.getLatestCommit (AT Protocol standard)
 *
 * The CID and revision of a repository's current commit. Same access rules
 * as sync.getRepo. A client moving a repository compares this with what the
 * new PDS reports before changing the DID.
 */
export default async function getLatestCommit(req: Request, res: Response): Promise<void> {
  try {
    const did = String(req.query.did || '');
    if (!did.startsWith('did:')) {
      res.status(400).json({ error: 'InvalidRequest', message: 'Missing or invalid required parameter: did' });
      return;
    }
    if (!(await requireRepoReadable(req as AuthRequest, res, did))) return;
    const root = (await query<{ root_cid: string; rev: string }>('SELECT root_cid, rev FROM repo_roots WHERE did = $1', [did])).rows[0];
    if (!root) {
      res.status(404).json({ error: 'RepoNotFound', message: `Repository not found for DID: ${did}` });
      return;
    }
    res.status(200).json({ cid: root.root_cid, rev: root.rev });
  } catch (error) {
    console.error('Error in sync.getLatestCommit:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get latest commit' });
  }
}
