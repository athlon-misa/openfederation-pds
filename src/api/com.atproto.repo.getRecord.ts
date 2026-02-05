import { Request, Response } from 'express';
import { SimpleRepoEngine } from '../repo/simple-engine.js';

/**
 * com.atproto.repo.getRecord
 *
 * Standard ATProto method to fetch a single record from a repository.
 * This is a GET request with query parameters.
 */
export default async function getRecord(req: Request, res: Response): Promise<void> {
  try {
    // Get query parameters
    const { repo, collection, rkey, cid } = req.query;

    // Validate required parameters
    if (!repo || !collection || !rkey) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required parameters: repo, collection, and rkey are required',
      });
      return;
    }

    // Validate types
    if (typeof repo !== 'string' || typeof collection !== 'string' || typeof rkey !== 'string') {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Parameters must be strings',
      });
      return;
    }

    // Optional: validate that repo is a valid DID
    if (!repo.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'repo must be a valid DID',
      });
      return;
    }

    // Create repository engine for this DID
    const engine = new SimpleRepoEngine(repo);

    // Get the record
    const result = await engine.getRecord(collection, rkey);

    if (!result) {
      res.status(404).json({
        error: 'RecordNotFound',
        message: `Record not found: ${collection}/${rkey}`,
      });
      return;
    }

    // If a specific CID was requested, verify it matches
    if (cid && typeof cid === 'string' && cid !== result.cid) {
      res.status(404).json({
        error: 'RecordNotFound',
        message: `Record found but CID does not match. Expected: ${cid}, Got: ${result.cid}`,
      });
      return;
    }

    // Return the record in standard ATProto format
    res.status(200).json({
      uri: `at://${repo}/${collection}/${rkey}`,
      cid: result.cid,
      value: result.record,
    });
  } catch (error) {
    console.error('Error getting record:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to retrieve record',
    });
  }
}
