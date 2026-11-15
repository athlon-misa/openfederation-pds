import { Response } from 'express';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { runtimeSettings } from '../settings/runtime-settings.js';
import { currentAtprotoKey, serverAtprotoKey, isRepoSigningDidKey } from '../identity/device-signing.js';
import { heldRotationDidKey } from '../identity/custody-change.js';
import { deviceSigningFeatures } from '../repo/device-signing-features.js';
import { HttpError, renderXrpcError } from '../xrpc/errors.js';

const NSID = 'net.openfederation.account.getDeviceSigning';

type State = 'off' | 'on' | 'resumable' | 'switchedBack';

/**
 * net.openfederation.account.getDeviceSigning (#240, ADR-003 decision 14)
 *
 * Everything a client needs to show the device-signing setting: whether this
 * installation offers it and the account can have it, whether it is on here,
 * the DID's `atproto` key as PLC names it now (read live, as submitCommit
 * does), and which features work while it is on. Changes nothing.
 *
 * `state` compares this server's flag with PLC:
 *   on            flag on, PLC names a key that is not this server's
 *   off           flag off, PLC names this server's key (or none)
 *   resumable     flag off, but PLC names a key that is not this server's
 *                 (after the person cancelled a switch back, or changed PLC
 *                 without telling this server): enableDeviceSigning turns it on
 *   switchedBack  flag on, but PLC names this server's key again (the next
 *                 submitCommit turns the flag off)
 *
 * PLC is the authority; a client that must not trust this server reads PLC
 * itself (findDeviceSigningSwitchBack in @open-federation/sdk/custody).
 */
export default async function getDeviceSigning(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const did = req.auth.did;
    const user = (await query<{ custody_mode: string | null; device_signing: boolean; device_signing_key: string | null; device_signing_since: Date | null }>(
      'SELECT custody_mode, device_signing, device_signing_key, device_signing_since FROM users WHERE did = $1', [did],
    )).rows[0];
    if (!user) throw new HttpError(400, 'InvalidRequest', 'Account not found');

    const allowed = runtimeSettings().identity.deviceSigningAllowed;
    const custodyMode = (user.custody_mode ?? null) as 'custodial' | 'assisted' | 'self' | null;
    const eligible = allowed && (custodyMode === 'self' || custodyMode === 'assisted');

    let atprotoKey: string | null = null;
    let plcReadable = true;
    try {
      atprotoKey = await currentAtprotoKey(did);
    } catch {
      plcReadable = false;
    }
    const serverKey = await serverAtprotoKey(did);
    const serverKeys = [serverKey, await heldRotationDidKey(did)].filter((k): k is string => !!k);
    const plcNamesDevice = !!atprotoKey && isRepoSigningDidKey(atprotoKey) && !serverKeys.includes(atprotoKey);

    let state: State;
    if (user.device_signing) {
      state = plcReadable && atprotoKey !== null && !plcNamesDevice ? 'switchedBack' : 'on';
    } else {
      state = plcNamesDevice && (custodyMode === 'self' || custodyMode === 'assisted') ? 'resumable' : 'off';
    }

    res.status(200).json({
      allowed,
      custodyMode,
      eligible,
      deviceSigning: user.device_signing === true,
      since: user.device_signing_since ? new Date(user.device_signing_since).toISOString() : null,
      recordedKey: user.device_signing_key,
      atprotoKey,
      plcReadable,
      serverKey,
      state,
      features: deviceSigningFeatures(),
    });
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
