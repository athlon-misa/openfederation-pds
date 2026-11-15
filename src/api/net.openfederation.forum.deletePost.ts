import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import type { AuthContext } from '../auth/types.js';
import { requireAuth, writableStatus, requireCommunityRole } from '../auth/guards.js';
import { isImportedRecord, recordImportTombstone } from '../forum/import.js';
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

    // An imported post (#86) is the community's own record: nobody here wrote
    // it, so its owner (or a PDS admin) deletes it, naming the community. Its
    // record key is remembered, so running the import again does not bring
    // it back (#403).
    if (req.body.community !== undefined) {
      const community = req.body.community;
      if (typeof community !== 'string' || !community.startsWith('did:')) {
        res.status(400).json({ error: 'InvalidRequest', message: 'community must be a DID' });
        return;
      }
      const role = await requireCommunityRole(req as AuthRequest & { auth: AuthContext }, res, community, ['owner']);
      if (!role) return;
      // A PDS admin passes the role check without the status check.
      const status = await query<{ status: string }>('SELECT status FROM communities WHERE did = $1', [community]);
      if (status.rows[0] && !writableStatus(status.rows[0].status, res)) return;
      const uri = `at://${community}/${FORUM_POST}/${rkey}`;
      const imported = await query<{ record: Record<string, unknown> }>(
        'SELECT record FROM forum_posts WHERE uri = $1 AND author_did = $2', [uri, community],
      );
      const record = imported.rows[0]?.record;
      if (!record || !isImportedRecord(record)) {
        res.status(404).json({ error: 'NotFound', message: 'No imported post with that rkey in this community' });
        return;
      }
      // The tombstone first: a crash after it leaves a post that a re-run would not restore, never the reverse.
      await recordImportTombstone(uri, record);
      await deleteMemberContent(uri);
      await deindexPost(uri);
      await auditLog('forum.post.delete', req.auth!.userId, community, { uri, imported: true });
      res.status(200).json({ success: true });
      return;
    }

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
      // In the author's own repo, whose device signs it (#240): through
      // net.openfederation.repo.prepareAction, the deletion is the device's commit.
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
