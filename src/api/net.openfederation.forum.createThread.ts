import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { indexThread, FORUM_THREAD } from '../forum/forum-index.js';
import { auditLog } from '../db/audit.js';

export default async function createThread(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { community, title, tags } = req.body;
    if (!community || typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'InvalidRequest', message: 'community and title are required' });
      return;
    }

    const hasPermission = await requireCommunityPermission(
      req as AuthRequest & { auth: AuthContext }, res, community, 'community.forum.write'
    );
    if (!hasPermission) return;

    const authorDid = req.auth!.did;
    const engine = new RepoEngine(authorDid);
    const keypair = await getKeypairForDid(authorDid);
    const rkey = RepoEngine.generateTid();
    const createdAt = new Date().toISOString();
    const tagList: string[] = Array.isArray(tags) ? tags.slice(0, 20).map(String) : [];

    const record = { $type: FORUM_THREAD, community, title: title.trim(), tags: tagList, createdAt };
    const result = await engine.putRecord(keypair, FORUM_THREAD, rkey, record);

    await indexThread({
      uri: result.uri, cid: result.cid, communityDid: community,
      authorDid, title: record.title, tags: tagList, createdAt,
    });

    await auditLog('forum.thread.create', req.auth!.userId, community, { uri: result.uri });
    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in forum.createThread:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create thread' });
  }
}
