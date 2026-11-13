import { Response } from 'express';
import { verifySignature } from '@atproto/crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { auditLog } from '../db/audit.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { RepoConcurrentWriteError } from '../repo/pg-blockstore.js';
import { takePendingCommit, dropPendingCommits } from '../repo/device-commits.js';
import { currentAtprotoKey, serverAtprotoKey } from '../identity/device-signing.js';
import { HttpError, renderXrpcError } from '../xrpc/errors.js';

const NSID = 'net.openfederation.repo.submitCommit';

/**
 * net.openfederation.repo.submitCommit (#240)
 *
 * Apply a commit prepared by net.openfederation.repo.prepareCommit, with the
 * device's signature over exactly the bytes prepare returned. In order:
 *
 *  1. The prepared commit is taken out of storage (only the account that
 *     prepared it can; a second submit of the same handle finds nothing).
 *  2. The DID's **current** `atproto` key is read from PLC, uncached. If PLC
 *     names this server's key again, device signing is switched off and the
 *     commit is refused.
 *  3. The signature must verify against that key (low-S, as AT Protocol).
 *  4. The repo root must still be the one the commit was built on; if not,
 *     the client prepares again.
 *  5. Blocks, root and records_index change in one transaction, as for every
 *     server-signed write.
 */
export default async function submitCommit(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const did = req.auth.did;
    const { handle, sig } = (req.body ?? {}) as { handle?: unknown; sig?: unknown };
    if (typeof handle !== 'string' || typeof sig !== 'string') {
      throw new HttpError(400, 'InvalidRequest', 'handle and sig are required');
    }
    const sigBytes = new Uint8Array(Buffer.from(sig, 'base64'));
    if (sigBytes.length !== 64) throw new HttpError(400, 'InvalidSignature', 'sig must be a 64-byte compact signature, base64');

    const prepared = await takePendingCommit(handle, did);
    if (!prepared) {
      throw new HttpError(400, 'UnknownCommit', 'No such prepared commit for this account: it was already submitted, or never prepared here');
    }
    if (prepared.expired) throw new HttpError(400, 'CommitExpired', 'The prepared commit expired; prepare it again');

    const user = (await query<{ id: string; device_signing: boolean }>('SELECT id, device_signing FROM users WHERE did = $1', [did])).rows[0];
    if (!user?.device_signing) throw new HttpError(400, 'DeviceSigningOff', 'Device signing is not on for this account');

    let key: string | null;
    try {
      key = await currentAtprotoKey(did);
    } catch {
      throw new HttpError(502, 'UpstreamFailure', 'The PLC directory could not be read; try again');
    }
    if (!key) throw new HttpError(400, 'InvalidSignature', 'The DID names no atproto key to check the signature against');

    if (key === await serverAtprotoKey(did)) {
      // PLC points back at this server's key: the device no longer signs.
      await query(
        'UPDATE users SET device_signing = false, device_signing_key = NULL, device_signing_since = NULL WHERE id = $1',
        [user.id],
      );
      await dropPendingCommits(did);
      await auditLog('account.deviceSigning.disable', user.id, user.id, { did, reason: 'plc-points-to-server-key' });
      throw new HttpError(400, 'DeviceSigningOff', 'The DID names this server\'s key again, so device signing is now off; write with com.atproto.repo.*');
    }

    let valid = false;
    try {
      valid = await verifySignature(key, prepared.unsigned, sigBytes);
    } catch {
      valid = false;
    }
    if (!valid) throw new HttpError(400, 'InvalidSignature', 'The signature does not verify against the DID\'s current atproto key');

    const engine = new RepoEngine(did);
    const root = await engine.getRoot();
    if (root?.toString() !== prepared.prevRoot) {
      throw new HttpError(409, 'RepoHeadMoved', 'The repository changed since this commit was prepared; prepare it again');
    }
    let commit: { cid: string; rev: string };
    try {
      commit = await engine.applyDeviceCommit(prepared, sigBytes);
    } catch (err) {
      if (err instanceof RepoConcurrentWriteError) {
        throw new HttpError(409, 'RepoHeadMoved', 'The repository changed since this commit was prepared; prepare it again');
      }
      throw err;
    }

    res.status(200).json({ commit, writes: prepared.results });
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
