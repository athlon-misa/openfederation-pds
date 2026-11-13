import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth, writableStatus } from '../auth/guards.js';
import { deindexPost, FORUM_POST } from '../forum/forum-index.js';
import { auditLog } from '../db/audit.js';
import { deleteMemberContent } from '../forum/member-content.js';
import { respondIfDeviceSigning } from '../repo/device-signing-state.js';
import { query } from '../db/client.js';

export default async function deletePost(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const { rkey } = req.body;
    if (!rkey || typeof rkey !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'rkey is required' });
      return;
    }
    const authorDid = req.auth!.did;

    // A post is in its author's repo (public community) or in the community's
    // (private community). Either way the index says who wrote it, and only
    // the author may delete it here.
    const found = await query<{ uri: string; community_did: string }>(
      `SELECT uri, community_did FROM forum_posts WHERE author_did = $1 AND uri LIKE $2`,
      [authorDid, `%/${FORUM_POST}/${rkey}`],
    );
    if (found.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'No post of yours with that rkey' });
      return;
    }
    const { uri, community_did: communityDid } = found.rows[0];
    if (uri.startsWith(`at://${communityDid}/`)) {
      // Stored in the community's repository: that repository must be writable.
      const community = await query<{ status: string }>('SELECT status FROM communities WHERE did = $1', [communityDid]);
      if (community.rows[0] && !writableStatus(community.rows[0].status, res)) return;
    } else if (await respondIfDeviceSigning(res, authorDid)) {
      // In the author's own repo, whose device signs it (#240).
      return;
    }

    await deleteMemberContent(uri);
    await deindexPost(uri);

    await auditLog('forum.post.delete', req.auth!.userId, authorDid, { uri });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in forum.deletePost:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to delete post' });
  }
}
