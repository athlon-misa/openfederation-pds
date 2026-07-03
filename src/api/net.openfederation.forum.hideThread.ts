import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { setThreadHidden } from '../forum/forum-index.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';

export default async function hideThread(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const { uri, hidden } = req.body;
    if (!uri || typeof uri !== 'string' || typeof hidden !== 'boolean') {
      res.status(400).json({ error: 'InvalidRequest', message: 'uri and hidden (boolean) are required' });
      return;
    }
    const lookup = await query<{ community_did: string }>(
      'SELECT community_did FROM forum_threads WHERE uri = $1', [uri]
    );
    if (lookup.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Thread not found' });
      return;
    }
    const communityDid = lookup.rows[0].community_did;

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, communityDid, 'community.forum.moderate'
    );
    if (!hasPermission) return;

    await setThreadHidden(uri, hidden);
    await auditLog(hidden ? 'forum.thread.hide' : 'forum.thread.unhide', req.auth!.userId, communityDid, { uri });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in forum.hideThread:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to update thread visibility' });
  }
}
