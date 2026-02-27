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

    // Look up by DID — check communities first, then users
    let repoOwner: { did: string; handle: string } | null = null;

    const communityResult = await query<{ did: string; handle: string }>(
      'SELECT did, handle FROM communities WHERE did = $1',
      [repo]
    );
    if (communityResult.rows.length > 0) {
      repoOwner = communityResult.rows[0];
    } else {
      const userResult = await query<{ did: string; handle: string }>(
        'SELECT did, handle FROM users WHERE did = $1',
        [repo]
      );
      if (userResult.rows.length > 0) {
        repoOwner = userResult.rows[0];
      }
    }

    if (!repoOwner) {
      res.status(404).json({
        error: 'RepoNotFound',
        message: `Repository not found for DID: ${repo}`,
      });
      return;
    }

    // Get distinct collections in this repo
    const collectionsResult = await query<{ collection: string }>(
      'SELECT DISTINCT collection FROM records_index WHERE community_did = $1 ORDER BY collection',
      [repo]
    );

    const collections = collectionsResult.rows.map(r => r.collection);

    res.status(200).json({
      handle: repoOwner.handle,
      did: repoOwner.did,
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
