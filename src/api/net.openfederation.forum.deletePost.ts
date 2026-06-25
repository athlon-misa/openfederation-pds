import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { deindexPost, FORUM_POST } from '../forum/forum-index.js';
import { auditLog } from '../db/audit.js';

export default async function deletePost(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const { rkey } = req.body;
    if (!rkey || typeof rkey !== 'string') {
      res.status(400).json({ error: 'InvalidRequest', message: 'rkey is required' });
      return;
    }
    const authorDid = req.auth!.did;
    const uri = `at://${authorDid}/${FORUM_POST}/${rkey}`;

    const engine = new RepoEngine(authorDid);
    const keypair = await getKeypairForDid(authorDid);
    await engine.deleteRecord(keypair, FORUM_POST, rkey);
    await deindexPost(uri);

    await auditLog('forum.post.delete', req.auth!.userId, authorDid, { uri });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error in forum.deletePost:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to delete post' });
  }
}
