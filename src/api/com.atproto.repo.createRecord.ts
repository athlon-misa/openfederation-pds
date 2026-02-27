import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityRole } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';

/**
 * com.atproto.repo.createRecord
 *
 * Create a new record in a repository with an auto-generated rkey (TID).
 * Requires auth and write permission on the target repo.
 */
export default async function createRecord(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const { repo, collection, record, rkey } = req.body;

    if (!repo || !collection || !record) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required fields: repo, collection, record',
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
    // For user repos, the repo DID must match the caller's DID.
    // For community repos, the caller must be owner/moderator or PDS admin.
    if (repo !== req.auth!.did) {
      const role = await requireCommunityRole(
        req as AuthRequest & { auth: AuthContext },
        res, repo, ['owner', 'moderator']
      );
      if (role === null) return; // response already sent by guard
    }

    const engine = new RepoEngine(repo);
    const keypair = await getKeypairForDid(repo);
    const recordKey = rkey || RepoEngine.generateTid();

    const result = await engine.putRecord(keypair, collection, recordKey, record);

    res.status(200).json({
      uri: result.uri,
      cid: result.cid,
    });
  } catch (error) {
    console.error('Error in createRecord:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to create record',
    });
  }
}
