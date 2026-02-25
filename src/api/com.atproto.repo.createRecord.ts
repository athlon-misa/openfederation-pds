import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';

/**
 * com.atproto.repo.createRecord
 *
 * Create a new record in a repository with an auto-generated rkey (TID).
 * Requires auth.
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
