import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { getThread, getThreadPosts } from '../forum/forum-index.js';

export default async function getThreadHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const uri = String(req.query.uri || '');
    if (!uri) {
      res.status(400).json({ error: 'InvalidRequest', message: 'uri is required' });
      return;
    }
    const thread = await getThread(uri);
    if (!thread || thread.hidden) {
      res.status(404).json({ error: 'NotFound', message: 'Thread not found' });
      return;
    }
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
    const after = req.query.after ? String(req.query.after) : null;
    const postRows = await getThreadPosts(uri, limit, after);
    const posts = postRows.map((p) => ({
      uri: p.uri, cid: p.cid, authorDid: p.author_did, parentUri: p.parent_uri,
      record: p.record, createdAt: p.created_at,
    }));
    const cursor = posts.length === limit ? String(postRows[postRows.length - 1].created_at) : undefined;
    res.status(200).json({
      thread: {
        uri: thread.uri, authorDid: thread.author_did, title: thread.title,
        tags: thread.tags, postCount: thread.post_count, createdAt: thread.created_at,
      },
      posts, cursor,
    });
  } catch (error) {
    console.error('Error in forum.getThread:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to get thread' });
  }
}
