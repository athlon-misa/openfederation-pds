import { Response } from 'express';
import { cidForRecord } from '@atproto/repo';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { query } from '../db/client.js';
import { RepoEngine } from '../repo/repo-engine.js';
import { assertPendingRoom, storePendingCommit, preparedCommitJson } from '../repo/device-commits.js';
import { DEVICE_ACTION_METHODS, runPrepare, forwardResponse } from '../repo/device-actions.js';
import { validateXrpcInput } from '../lexicon/runtime.js';
import { HttpError, renderXrpcError } from '../xrpc/errors.js';

const NSID = 'net.openfederation.repo.prepareAction';

/**
 * net.openfederation.repo.prepareAction (#240 phase 2)
 *
 * For an account with device signing on: run one of the methods that write
 * on the person's behalf (profile, contacts, forum, RSVPs, votes, objections)
 * up to the write the device must sign, and return that for signing:
 *
 *  - kind `commit`: a commit into the account's own repo, exactly as
 *    prepareCommit returns one, plus the writes it holds (with their records)
 *    so the device can check the new tree and what is in it;
 *  - kind `authorSig`: a record the account writes in a private community,
 *    stored in the community's repo, which the device signs as its author
 *    (the signature is over the record's CID);
 *  - kind `none`: the method finished without needing the device (nothing of
 *    the person's to sign); `result` is its answer.
 *
 * The method's own checks all run, and its errors are returned as they are.
 * Nothing changes until net.openfederation.repo.submitCommit, which runs the
 * method again with the device's signature in place (`src/repo/device-actions.ts`).
 */
export default async function prepareAction(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const did = req.auth.did;
    const { method, input } = (req.body ?? {}) as { method?: unknown; input?: unknown };
    if (typeof method !== 'string' || !DEVICE_ACTION_METHODS.has(method)) {
      throw new HttpError(400, 'UnsupportedMethod', `method must be one of: ${[...DEVICE_ACTION_METHODS].join(', ')}`);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new HttpError(400, 'InvalidRequest', 'input must be the method\'s input object');
    }
    const user = (await query<{ device_signing: boolean }>('SELECT device_signing FROM users WHERE did = $1', [did])).rows[0];
    if (!user?.device_signing) {
      throw new HttpError(400, 'DeviceSigningOff', `Device signing is not on for this account; call ${method} directly`);
    }
    const validation = validateXrpcInput(method, input);
    if (!validation.ok) throw new HttpError(400, 'InvalidRequest', validation.message);

    await assertPendingRoom(did);
    const { ctx, res: answer } = await runPrepare(req, did, method, input as Record<string, unknown>);
    const needed = ctx.needed;

    if (!needed) {
      if (answer.statusCode >= 400) {
        forwardResponse(res, answer);
        return;
      }
      res.status(200).json({ method, kind: 'none', result: answer.body ?? {} });
      return;
    }

    if (needed.kind === 'commit') {
      const prepared = await new RepoEngine(did).prepareDeviceCommit(needed.ops);
      const { handle, expiresAt } = await storePendingCommit({
        did, kind: 'commit', unsigned: prepared.unsigned, prepared,
        action: { method, input: input as Record<string, unknown>, ops: needed.ops },
      });
      const actions = new Map(prepared.indexOps.map((op) => [`${op.collection}/${op.rkey}`, op.action]));
      res.status(200).json({
        handle,
        method,
        kind: 'commit',
        expiresAt,
        commit: preparedCommitJson(did, handle, expiresAt, prepared),
        writes: needed.ops.map((op) => ({
          action: actions.get(`${op.collection}/${op.rkey}`) ?? (op.action === 'delete' ? 'delete' : 'create'),
          collection: op.collection,
          rkey: op.rkey,
          ...(op.action === 'write' ? { record: op.record } : {}),
        })),
      });
      return;
    }

    const cid = await cidForRecord(needed.planned.record);
    const { handle, expiresAt } = await storePendingCommit({
      did, kind: 'authorSig', unsigned: cid.bytes,
      action: { method, input: input as Record<string, unknown> },
      authorRecord: needed.planned,
    });
    res.status(200).json({
      handle,
      method,
      kind: 'authorSig',
      expiresAt,
      authorSig: { ...needed.planned, cid: cid.toString() },
    });
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
