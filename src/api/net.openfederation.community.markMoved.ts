import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { currentPlcState } from '../identity/account-migration.js';
import { CommunityMoveError, homeOf } from '../community/migration.js';

/** The owner marks the copy left behind by a move as moved (#267); it becomes read-only. */
export default async function markMoved(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  const did = typeof req.body?.did === 'string' ? req.body.did : '';
  try {
    const c = (await query<{ status: string; owner_did: string | null }>('SELECT status, owner_did FROM communities WHERE did = $1', [did])).rows[0];
    if (!c) throw new CommunityMoveError(404, 'NotFound', 'Community not found');
    if (c.owner_did !== req.auth.did && !req.auth.roles.includes('admin')) throw new CommunityMoveError(403, 'Forbidden', 'Only the community owner can do this');
    const state = await currentPlcState(did);
    const home = state ? homeOf(state) : null;
    if (!home) throw new CommunityMoveError(400, 'NotMoved', 'The DID still points to this PDS');
    if (c.status !== 'moved') {
      await query(`UPDATE communities SET status = 'moved', status_changed_at = CURRENT_TIMESTAMP, status_reason = $2 WHERE did = $1`, [did, `moved to ${home}`]);
      await auditLog('community.moved', req.auth.authMethod === 'service-auth' ? null : req.auth.userId, did, { to: home });
    }
    res.status(200).json({ did, status: 'moved', home });
  } catch (error) {
    if (error instanceof CommunityMoveError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in community.markMoved:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to mark the community as moved' });
  }
}
