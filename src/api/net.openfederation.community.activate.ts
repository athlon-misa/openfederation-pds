import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { currentPlcState, pointsHere } from '../identity/account-migration.js';
import { CommunityMoveError, fetchMovedKeys, missingAttestationKeys } from '../community/migration.js';

/**
 * The owner switches a community on here once its DID points here (#267).
 * Fetches the attestation keys from the old home; if that fails the
 * community still activates and the call can be repeated for the keys.
 */
export default async function activateCommunity(req: AuthRequest, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;
  const did = typeof req.body?.did === 'string' ? req.body.did : '';
  try {
    const c = (await query<{ status: string; owner_did: string | null; from_pds: string | null }>(
      'SELECT status, owner_did, from_pds FROM communities WHERE did = $1', [did])).rows[0];
    if (!c) throw new CommunityMoveError(404, 'NotFound', 'No copy of this community here');
    if (c.owner_did !== req.auth.did && !req.auth.roles.includes('admin')) {
      throw new CommunityMoveError(403, 'Forbidden', 'Only the community owner can activate it');
    }
    if (c.status !== 'importing' && c.status !== 'active') throw new CommunityMoveError(400, 'InvalidStatus', `Community is ${c.status}`);

    const state = await currentPlcState(did);
    const keypair = await getKeypairForDid(did);
    if (!state || !pointsHere(state, config.pds.serviceUrl, keypair.did())) {
      throw new CommunityMoveError(400, 'IncompatibleDidDoc', 'The DID does not point to this PDS and its signing key yet; update it in the PLC directory first');
    }

    let keysImported: number | null = null;
    if (c.from_pds && (await missingAttestationKeys(did)) > 0) {
      keysImported = await fetchMovedKeys(did, c.from_pds);
    }
    if (c.status === 'importing') {
      await query(`UPDATE communities SET status = 'active', status_changed_at = CURRENT_TIMESTAMP, status_reason = NULL WHERE did = $1`, [did]);
      await auditLog('community.activate', req.auth.authMethod === 'service-auth' ? null : req.auth.userId, did, { ownerDid: req.auth.did, keysImported });
    }
    res.status(200).json({ did, status: 'active', keysImported, missingAttestationKeys: await missingAttestationKeys(did) });
  } catch (error) {
    if (error instanceof CommunityMoveError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    console.error('Error in community.activate:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to activate the community' });
  }
}
