import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityPermission } from '../auth/guards.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { indexPost, getThread, FORUM_POST } from '../forum/forum-index.js';
import { auditLog } from '../db/audit.js';

function isStrongRef(v: unknown): v is { uri: string; cid: string } {
  return !!v && typeof v === 'object'
    && typeof (v as { uri?: unknown }).uri === 'string'
    && typeof (v as { cid?: unknown }).cid === 'string';
}

export default async function createPost(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    const { community, root, parent, text } = req.body;
    if (!community || !isStrongRef(root) || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'InvalidRequest', message: 'community, root {uri,cid}, and text are required' });
      return;
    }
    if (parent !== undefined && !isStrongRef(parent)) {
      res.status(400).json({ error: 'InvalidRequest', message: 'parent must be a strongRef {uri,cid}' });
      return;
    }

    // Thread must exist in the index and belong to the same community.
    const thread = await getThread(root.uri);
    if (!thread) {
      res.status(404).json({ error: 'ThreadNotFound', message: 'Thread root not found' });
      return;
    }
    if (thread.community_did !== community) {
      res.status(400).json({ error: 'InvalidRequest', message: 'root thread does not belong to this community' });
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

    const record: Record<string, unknown> = {
      $type: FORUM_POST, community, root, text: text.trim(), createdAt,
      ...(parent ? { parent } : {}),
    };
    const result = await engine.putRecord(keypair, FORUM_POST, rkey, record);

    await indexPost({
      uri: result.uri, cid: result.cid, communityDid: community, authorDid,
      threadRootUri: root.uri, parentUri: parent ? parent.uri : null,
      record, createdAt,
    });

    await auditLog('forum.post.create', req.auth!.userId, community, { uri: result.uri, root: root.uri });
    res.status(200).json({ uri: result.uri, cid: result.cid, rkey });
  } catch (error) {
    console.error('Error in forum.createPost:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to create post' });
  }
}
