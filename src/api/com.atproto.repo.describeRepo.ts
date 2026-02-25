import { Request, Response } from 'express';
import { query } from '../db/client.js';

/**
 * com.atproto.repo.describeRepo
 *
 * Describe a repository — returns the DID, handle, and collections present.
 * No auth required.
 */
export default async function describeRepo(req: Request, res: Response): Promise<void> {
  try {
    const repo = String(req.query.repo || '');
    if (!repo || !repo.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing or invalid required parameter: repo',
      });
      return;
    }

    // Look up community by DID
    const communityResult = await query<{ did: string; handle: string }>(
      'SELECT did, handle FROM communities WHERE did = $1',
      [repo]
    );

    if (communityResult.rows.length === 0) {
      res.status(404).json({
        error: 'RepoNotFound',
        message: `Repository not found for DID: ${repo}`,
      });
      return;
    }

    const community = communityResult.rows[0];

    // Get distinct collections in this repo
    const collectionsResult = await query<{ collection: string }>(
      'SELECT DISTINCT collection FROM records_index WHERE community_did = $1 ORDER BY collection',
      [repo]
    );

    const collections = collectionsResult.rows.map(r => r.collection);

    res.status(200).json({
      handle: community.handle,
      did: community.did,
      didDoc: {}, // TODO: build from PLC/web identity
      collections,
      handleIsCorrect: true,
    });
  } catch (error) {
    console.error('Error in describeRepo:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to describe repository',
    });
  }
}
