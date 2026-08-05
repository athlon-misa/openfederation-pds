import { Request, Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRepoReadable } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';

/**
 * Write a CAR iterable without allowing Node's response buffer to grow with
 * the repository. `res.write()` returning false is an explicit signal to
 * pause until the client drains its socket; a closed response stops the
 * export without reading additional blocks from storage.
 */
export async function writeCarStream(
  req: Request,
  res: Response,
  carStream: AsyncIterable<Uint8Array>,
): Promise<void> {
  let closed = res.destroyed;
  const onClose = () => { closed = true; };
  const onAborted = () => { closed = true; };
  res.once('close', onClose);
  req.once('aborted', onAborted);

  try {
    for await (const chunk of carStream) {
      if (closed || res.destroyed || res.writableEnded) break;
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          const resume = () => {
            res.off('drain', resume);
            res.off('close', resume);
            req.off('aborted', resume);
            resolve();
          };
          res.once('drain', resume);
          res.once('close', resume);
          req.once('aborted', resume);
        });
      }
      if (closed || res.destroyed || res.writableEnded) break;
    }
  } finally {
    res.off('close', onClose);
    req.off('aborted', onAborted);
  }

  if (!closed && !res.destroyed && !res.writableEnded) res.end();
}

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

    if (!(await requireRepoReadable(req as AuthRequest, res, did))) return;

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

    await writeCarStream(req, res, carStream);
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
