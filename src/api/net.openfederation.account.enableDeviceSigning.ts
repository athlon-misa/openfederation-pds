import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { runtimeSettings } from '../settings/runtime-settings.js';
import { currentAtprotoKey, serverAtprotoKey, isRepoSigningDidKey } from '../identity/device-signing.js';
import { heldRotationDidKey } from '../identity/custody-change.js';
import { HttpError, renderXrpcError } from '../xrpc/errors.js';

const NSID = 'net.openfederation.account.enableDeviceSigning';

/**
 * net.openfederation.account.enableDeviceSigning (#240, ADR-003 decision 14)
 *
 * Record that this account's device signs its repository. Called after the
 * person has signed (with their phrase) the PLC update that makes the DID's
 * `atproto` key their device key; this server cannot make that update for a
 * `self` account, and does not for an `assisted` one.
 *
 * Turned on only when PLC already names a key that is not one of this
 * server's keys for the DID. From then on every server-side write into the
 * account's repo refuses, and writes go through prepareCommit/submitCommit.
 * Idempotent.
 */
export default async function enableDeviceSigning(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const did = req.auth.did;
    if (!runtimeSettings().identity.deviceSigningAllowed) {
      throw new HttpError(403, 'DeviceSigningNotAllowed', 'This server does not offer device signing');
    }
    const user = (await query<{ id: string; custody_mode: string | null }>(
      'SELECT id, custody_mode FROM users WHERE did = $1', [did],
    )).rows[0];
    if (!user) throw new HttpError(400, 'InvalidRequest', 'Account not found');
    if (user.custody_mode !== 'self' && user.custody_mode !== 'assisted') {
      throw new HttpError(400, 'CustodyModeNotSupported', 'Device signing needs a self or assisted account: only the person\'s own rotation key may point the DID at their device');
    }

    let key: string | null;
    try {
      key = await currentAtprotoKey(did);
    } catch {
      throw new HttpError(502, 'UpstreamFailure', 'The PLC directory could not be read; try again');
    }
    if (!key || !isRepoSigningDidKey(key)) {
      throw new HttpError(400, 'AtprotoKeyNotDevice', 'The DID names no usable atproto key; update it at PLC with your device key first');
    }
    const serverKeys = [await serverAtprotoKey(did), await heldRotationDidKey(did)];
    if (serverKeys.includes(key)) {
      throw new HttpError(400, 'AtprotoKeyNotDevice', 'The DID\'s atproto key is still this server\'s key. Sign the PLC update that names your device key with your phrase first (enableDeviceSigning in @open-federation/sdk/custody)');
    }

    await query(
      `UPDATE users SET device_signing = true, device_signing_key = $2,
         device_signing_since = COALESCE(CASE WHEN device_signing THEN device_signing_since END, NOW())
       WHERE id = $1`,
      [user.id, key],
    );
    await auditLog('account.deviceSigning.enable', user.id, user.id, { did, atprotoKey: key });
    res.status(200).json({ deviceSigning: true, atprotoKey: key });
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
