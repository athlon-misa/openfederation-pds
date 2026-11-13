import { Response } from 'express';
import type { AuthRequest, AuthContext } from '../auth/types.js';
import { requireAuth, requireCommunityRole, requireActiveCommunity } from '../auth/guards.js';
import { auditLog } from '../db/audit.js';
import { ImportBatchError, importForumBatch, parseImportBatch } from '../forum/import.js';

/**
 * net.openfederation.forum.importBatch (#86)
 *
 * Writes a batch of threads and posts brought over from another platform
 * into the community's own repository. The importer (`ofc community import
 * discord`) does the reading and mapping on the organiser's machine; see
 * `src/forum/import.ts` for what is written and why.
 *
 * Owner (or PDS admin) only: the records are signed with the community's key,
 * so this speaks for the community as a whole.
 */
export default async function importBatch(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;

    let batch;
    try {
      batch = parseImportBatch(req.body);
    } catch (err) {
      if (err instanceof ImportBatchError) {
        res.status(400).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    const role = await requireCommunityRole(req as AuthRequest & { auth: AuthContext }, res, batch.community, ['owner']);
    if (!role) return;
    // A PDS admin passes the role check without the community being looked
    // up; this refuses a missing, moved, arriving or frozen community for them too.
    if (!(await requireActiveCommunity(batch.community, res))) return;

    let result;
    try {
      result = await importForumBatch(batch);
    } catch (err) {
      if (err instanceof ImportBatchError) {
        res.status(400).json({ error: err.code, message: err.message });
        return;
      }
      throw err;
    }

    // One entry per batch. Counts only: no titles, text or source names.
    await auditLog('forum.import', req.auth!.userId, batch.community, {
      platform: batch.platform,
      threadsCreated: result.threads.created,
      postsCreated: result.posts.created,
      threadsExisting: result.threads.existing,
      postsExisting: result.posts.existing,
    });

    res.status(200).json(result);
  } catch (error) {
    console.error('Error in forum.importBatch:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to import batch' });
  }
}
