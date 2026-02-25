import { Request, Response } from 'express';
import { RepoEngine } from '../repo/repo-engine.js';

/**
 * com.atproto.sync.getRepo
 *
 * Export a full repository as a CAR (Content Addressable aRchive) stream.
 * This is a core AT Protocol federation endpoint — relays and other services
 * use it to read repository data.
 *
 * No auth required (public repos are public in AT Protocol).
 */
export default async function syncGetRepo(req: Request, res: Response): Promise<void> {
  try {
    const did = String(req.query.did || '');
    if (!did || !did.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing or invalid required parameter: did',
      });
      return;
    }

    const engine = new RepoEngine(did);
    const hasRepo = await engine.hasRepo();
    if (!hasRepo) {
      res.status(404).json({
        error: 'RepoNotFound',
        message: `Repository not found for DID: ${did}`,
      });
      return;
    }

    const carStream = await engine.exportAsCAR();

    res.setHeader('Content-Type', 'application/vnd.ipld.car');
    res.setHeader('Transfer-Encoding', 'chunked');

    for await (const chunk of carStream) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error('Error in sync.getRepo:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'InternalServerError',
        message: 'Failed to export repository',
      });
    }
  }
}
