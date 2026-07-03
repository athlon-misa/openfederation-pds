import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { listThreads } from '../forum/forum-index.js';
import { callerCanModerateForum } from '../community/visibility.js';

export default async function listThreadsHandler(req: AuthRequest, res: Response): Promise<void> {
  try {
    const community = String(req.query.community || '');
    if (!community) {
      res.status(400).json({ error: 'InvalidRequest', message: 'community is required' });
      return;
    }
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
    const before = req.query.before ? String(req.query.before) : null;

    // Moderators (community.forum.moderate) also see hidden threads, so they
    // can find and unhide them. Same gate as forum.hidePost / getThread.
    const canModerate = await callerCanModerateForum(community, req.auth);

    const rows = await listThreads(community, limit, before, { includeHidden: canModerate });
    const threads = rows.map((t) => ({
      uri: t.uri, cid: t.cid, authorDid: t.author_did, title: t.title,
      tags: t.tags, postCount: t.post_count, lastActivity: t.last_activity,
      hidden: Boolean(t.hidden), createdAt: t.created_at,
    }));
    const cursor = threads.length === limit ? String(rows[rows.length - 1].last_activity) : undefined;
    res.status(200).json({ threads, cursor });
  } catch (error) {
    console.error('Error in forum.listThreads:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to list threads' });
  }
}
