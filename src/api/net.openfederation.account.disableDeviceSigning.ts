import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { currentAtprotoKey, serverAtprotoKey } from '../identity/device-signing.js';
import { dropPendingCommits } from '../repo/device-commits.js';
import { HttpError, renderXrpcError } from '../xrpc/errors.js';

const NSID = 'net.openfederation.account.disableDeviceSigning';

/**
 * net.openfederation.account.disableDeviceSigning (#240, ADR-003 decision 14)
 *
 * Let this server sign the account's commits again. Only once PLC names this
 * server's repo key as the DID's `atproto` key again (a PLC update the person
 * signs with their phrase; com.atproto.identity.getRecommendedDidCredentials
 * gives the key): until then a server-signed commit would not verify, so the
 * flag stays on. Prepared commits are dropped. Idempotent.
 */
export default async function disableDeviceSigning(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const did = req.auth.did;
    const user = (await query<{ id: string; device_signing: boolean }>(
      'SELECT id, device_signing FROM users WHERE did = $1', [did],
    )).rows[0];
    if (!user) throw new HttpError(400, 'InvalidRequest', 'Account not found');
    if (!user.device_signing) {
      res.status(200).json({ deviceSigning: false });
      return;
    }

    let key: string | null;
    try {
      key = await currentAtprotoKey(did);
    } catch {
      throw new HttpError(502, 'UpstreamFailure', 'The PLC directory could not be read; try again');
    }
    const serverKey = await serverAtprotoKey(did);
    if (!serverKey || key !== serverKey) {
      throw new HttpError(400, 'AtprotoKeyNotServer', 'The DID still names your device key. Sign the PLC update that names this server\'s key (getRecommendedDidCredentials) with your phrase first (disableDeviceSigning in @open-federation/sdk/custody)');
    }

    await query(
      'UPDATE users SET device_signing = false, device_signing_key = NULL, device_signing_since = NULL WHERE id = $1',
      [user.id],
    );
    await dropPendingCommits(did);
    await auditLog('account.deviceSigning.disable', user.id, user.id, { did });
    res.status(200).json({ deviceSigning: false });
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
