import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { invalidateAuthContext } from '../auth/auth-context-cache.js';
import { config } from '../config.js';
import { getKeypairForDid } from '../repo/keypair-utils.js';
import { currentPlcState, pointsHere } from '../identity/account-migration.js';

/**
 * com.atproto.server.activateAccount
 *
 * ATProto-standard user self-service endpoint. The authenticated user
 * reactivates their own account after self-deactivation.
 *
 * Only works if the account was deactivated by the user themselves
 * (status = 'deactivated'). Admin-suspended or taken-down accounts
 * cannot be reactivated by the user.
 *
 * Also the last step of account migration (#263): an account that moved
 * here is activated once its DID names this PDS and this PDS's signing key.
 */
export default async function activateAccount(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) {
      return;
    }

    const userId = req.auth!.userId;
    const userDid = req.auth!.did;

    // Fetch current status
    const userResult = await query<{ status: string; migrating_in: boolean; auth_type: string }>(
      'SELECT status, migrating_in, auth_type FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Account not found' });
      return;
    }

    const user = userResult.rows[0];

    if (user.status !== 'deactivated') {
      if (user.status === 'suspended') {
        res.status(403).json({
          error: 'AccountSuspended',
          message: 'Your account has been suspended by an administrator. Contact support.',
        });
        return;
      }
      if (user.status === 'takendown') {
        res.status(410).json({
          error: 'AccountTakenDown',
          message: 'Your account has been taken down.',
        });
        return;
      }
      res.status(400).json({
        error: 'InvalidStatus',
        message: 'Account is not deactivated',
      });
      return;
    }

    // An account is switched on only where its DID points (#265): one DID
    // never has two live homes, and a copy left behind by a move can be
    // switched on again simply by pointing the DID back. Accounts that are
    // not in the PLC directory (the bootstrap admin) have nowhere else to be.
    const state = await currentPlcState(userDid).catch(() => undefined);
    if (state === undefined) {
      res.status(502).json({ error: 'UpstreamFailure', message: 'The PLC directory could not be reached; try again later' });
      return;
    }
    if (state !== null) {
      const keypair = await getKeypairForDid(userDid);
      if (!pointsHere(state, config.pds.serviceUrl, keypair.did())) {
        res.status(400).json({
          error: 'IncompatibleDidDoc',
          message: 'The DID does not point to this PDS and its signing key; update it in the PLC directory first',
        });
        return;
      }
    }

    // Pseudonyms keep no status timestamps (they could line up with the owner's activity).
    const stamped = user.auth_type !== 'pseudonym';
    await query(
      `UPDATE users
       SET status = 'approved', migrating_in = false, token_version = token_version + 1,
           approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
           status_changed_at = ${stamped ? 'CURRENT_TIMESTAMP' : 'NULL'}, status_changed_by = ${stamped ? '$1' : 'NULL'}, status_reason = NULL
       WHERE id = $1`,
      [userId]
    );
    await auditLog('account.activate', userId, userId, { did: userDid, migrated: user.migrating_in });
    invalidateAuthContext(userDid);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error activating account:', error);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to activate account' });
  }
}
