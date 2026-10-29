import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { currentPlcState } from '../identity/account-migration.js';
import { CommunityMoveError, homeOf, sealMovedKeys } from '../community/migration.js';

/**
 * The old home hands over a moved community's attestation keys (#267),
 * sealed to the signing key the DID now names, so only the new home can
 * read them. Answers only once the PLC directory says the community lives
 * elsewhere, and marks the copy here as moved.
 */
export default async function getMovedKeys(req: AuthRequest, res: Response): Promise<void> {
  const did = String(req.query.did || '');
  try {
    const c = (await query<{ status: string }>('SELECT status FROM communities WHERE did = $1', [did])).rows[0];
    if (!c || c.status === 'importing') throw new CommunityMoveError(404, 'NotFound', 'No community with this DID here');
    const state = await currentPlcState(did);
    if (!state) throw new CommunityMoveError(400, 'UnresolvableDid', 'DID is not in the PLC directory');
    const home = homeOf(state);
    if (!home) throw new CommunityMoveError(400, 'NotMoved', 'The DID still points to this PDS');
    const recipient = state.verificationMethods.atproto;
    if (!recipient) throw new CommunityMoveError(400, 'IncompatibleDidDoc', 'The DID names no atproto signing key');

    if (c.status !== 'moved') {
      await query(`UPDATE communities SET status = 'moved', status_changed_at = CURRENT_TIMESTAMP, status_reason = $2 WHERE did = $1`, [did, `moved to ${home}`]);
      await auditLog('community.moved', null, did, { to: home });
    }
    const { count, sealed } = await sealMovedKeys(did, recipient);
    await auditLog('community.movedKeys.served', null, did, { to: home, recipient, count });
    res.status(200).json({ did, recipient, count, sealed });
  } catch (error) {
    if (error instanceof CommunityMoveError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in community.getMovedKeys:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to hand over the keys' });
  }
}
