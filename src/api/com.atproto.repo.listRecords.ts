import { Request, Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireRepoReadable } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { parsePagination } from '../xrpc/pagination.js';

/**
 * com.atproto.repo.listRecords
 *
 * List records in a specific collection of a repository.
 * No auth required for public repos.
 */
export default async function listRecords(req: Request, res: Response): Promise<void> {
  try {
    const repo = String(req.query.repo || '');
    const collection = String(req.query.collection || '');
    const { limit, cursor } = parsePagination(req.query);
    const reverse = req.query.reverse === 'true';

    if (!repo || !repo.startsWith('did:')) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing or invalid required parameter: repo',
      });
      return;
    }

    if (!collection) {
      res.status(400).json({
        error: 'InvalidRequest',
        message: 'Missing required parameter: collection',
      });
      return;
    }

    if (!(await requireRepoReadable(req as AuthRequest, res, repo))) return;

    const engine = new RepoEngine(repo);
    const result = await engine.listRecords(collection, limit, cursor);

    const records = result.records.map(r => ({
      uri: `at://${repo}/${collection}/${r.rkey}`,
      cid: r.cid,
      value: r.record,
    }));

    if (reverse) {
      records.reverse();
    }

    res.status(200).json({
      records,
      cursor: result.cursor,
    });
  } catch (error) {
    console.error('Error in listRecords:', error);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'Failed to list records',
    });
  }
}
