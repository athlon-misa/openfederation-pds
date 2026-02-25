import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';

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

    const engine = new RepoEngine(repo);
    const keypair = await getKeypairForDid(repo);

    const result = await engine.putRecord(keypair, collection, rkey, record);

    res.status(200).json({
      uri: result.uri,
      cid: result.cid,
    });
  } catch (error) {
    console.error('Error in putRecord:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to write record',
    });
  }
}
