import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityRole } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';

/**
 * com.atproto.repo.deleteRecord
 *
 * Delete a record from a repository. Requires auth and write permission.
 */
export default async function deleteRecord(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { repo, collection, rkey } = req.body;

    if (!repo || !collection || !rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: repo, collection, rkey',
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

    // Authorization: caller must have write access to this repo.
    if (repo !== req.auth!.did) {
      const role = await requireCommunityRole(
        req as AuthRequest & { auth: AuthContext },
        res, repo, ['owner', 'moderator']
      );
      if (role === null) return;
    }

    const engine = new RepoEngine(repo);
    const keypair = await getKeypairForDid(repo);

    await engine.deleteRecord(keypair, collection, rkey);

    res.status(200).json({});
  } catch (error) {
    console.error('Error in deleteRecord:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to delete record',
    });
  }
}
