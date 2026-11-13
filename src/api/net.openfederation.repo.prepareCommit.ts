import { Response } from 'express';
import { randomBytes } from 'crypto';
import type { AuthRequest } from '../auth/types.js';
import { requireAuth } from '../auth/guards.js';
import { enforcePseudonymProbation } from '../auth/pseudonym-probation.js';
import { query } from '../db/client.js';
import { RepoEngine, type BatchOp } from '../repo/repo-engine.js';
import { authorizeCollectionMutation } from '../repo/collection-policy.js';
import { FORUM_THREAD, FORUM_POST, CALENDAR_EVENT, CALENDAR_RSVP } from '../forum/forum-index.js';
import { HttpError, renderXrpcError } from '../xrpc/errors.js';
import { PENDING_COMMIT_TTL_SECONDS, MAX_PENDING_COMMITS, MAX_WRITES_PER_COMMIT } from '../repo/device-commits.js';

const NSID = 'net.openfederation.repo.prepareCommit';
const DEDICATED = new Set([FORUM_THREAD, FORUM_POST, CALENDAR_EVENT, CALENDAR_RSVP]);
const NSID_PATTERN = /^[a-zA-Z]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
const RKEY_PATTERN = /^[a-zA-Z0-9._:~-]{1,512}$/;

type Action = 'create' | 'update' | 'delete';

function actionOf(write: Record<string, unknown>): Action | null {
  const raw = typeof write.action === 'string' ? write.action
    : typeof write.$type === 'string' ? write.$type.replace(/^com\.atproto\.repo\.applyWrites#/, '') : '';
  return raw === 'create' || raw === 'update' || raw === 'delete' ? raw : null;
}

/**
 * net.openfederation.repo.prepareCommit (#240)
 *
 * For an account with device signing on: build the commit for a set of
 * writes (the inputs of com.atproto.repo.createRecord / putRecord /
 * deleteRecord / applyWrites) on the repo's current root, without signing it.
 * Returns the exact bytes the device must sign (the commit's DAG-CBOR without
 * `sig`), the new blocks so the device can check what it signs, and a handle
 * for net.openfederation.repo.submitCommit. The pending commit is bound to
 * the account and to the root it was built on, expires after a few minutes,
 * and an account may hold only a few at once.
 */
export default async function prepareCommit(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!requireAuth(req, res)) return;
    const did = req.auth.did;
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (body.repo !== undefined && body.repo !== did) {
      throw new HttpError(403, 'Forbidden', 'A device signs only its own account\'s repository');
    }
    const user = (await query<{ device_signing: boolean }>('SELECT device_signing FROM users WHERE did = $1', [did])).rows[0];
    if (!user?.device_signing) {
      throw new HttpError(400, 'DeviceSigningOff', 'Device signing is not on for this account; write with com.atproto.repo.* instead');
    }

    if (!Array.isArray(body.writes) || body.writes.length === 0) {
      throw new HttpError(400, 'InvalidRequest', 'writes must be a non-empty array');
    }
    if (body.writes.length > MAX_WRITES_PER_COMMIT) {
      throw new HttpError(400, 'InvalidRequest', `At most ${MAX_WRITES_PER_COMMIT} writes per commit`);
    }

    const ops: BatchOp[] = [];
    for (const raw of body.writes as unknown[]) {
      if (!raw || typeof raw !== 'object') throw new HttpError(400, 'InvalidRequest', 'Each write must be an object');
      const write = raw as Record<string, unknown>;
      const action = actionOf(write);
      if (!action) throw new HttpError(400, 'InvalidRequest', 'Each write needs action create, update or delete');
      const collection = write.collection;
      if (typeof collection !== 'string' || !NSID_PATTERN.test(collection)) {
        throw new HttpError(400, 'InvalidRequest', 'collection must be an NSID');
      }
      let rkey = write.rkey;
      if (rkey === undefined && action === 'create') rkey = RepoEngine.generateTid();
      if (typeof rkey !== 'string' || !RKEY_PATTERN.test(rkey) || rkey === '.' || rkey === '..') {
        throw new HttpError(400, 'InvalidRequest', 'rkey is missing or not a valid record key');
      }
      if (DEDICATED.has(collection)) {
        throw new HttpError(400, 'UseDedicatedEndpoint', `Records in "${collection}" are written through their net.openfederation.forum.* / calendar.* endpoint`);
      }
      // The same collection rules as the generic writes: votes, objections,
      // decisions and checked key claims are not hand-written.
      await authorizeCollectionMutation({ actor: req.auth, repo: did, collection, operation: action });
      if (action === 'delete') {
        ops.push({ action: 'delete', collection, rkey });
      } else {
        const value = write.value ?? write.record;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new HttpError(400, 'InvalidRequest', 'create and update need a record object (value)');
        }
        ops.push({ action: 'write', collection, rkey, record: value as Record<string, unknown> });
      }
    }

    if (!(await enforcePseudonymProbation(req, res))) return;

    // Expired prepares go first, so they never count against the limit.
    await query('DELETE FROM pending_device_commits WHERE expires_at < NOW()');
    const pending = await query<{ n: string }>('SELECT COUNT(*) AS n FROM pending_device_commits WHERE did = $1', [did]);
    if (parseInt(pending.rows[0].n, 10) >= MAX_PENDING_COMMITS) {
      throw new HttpError(429, 'TooManyPendingCommits', `At most ${MAX_PENDING_COMMITS} prepared commits may wait at once; submit or let them expire`);
    }

    const prepared = await new RepoEngine(did).prepareDeviceCommit(ops);
    const handle = randomBytes(16).toString('hex');
    const expires = await query<{ expires_at: Date }>(
      `INSERT INTO pending_device_commits
         (id, did, prev_root, since, rev, unsigned_commit, new_blocks, removed_cids, index_ops, results, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + make_interval(secs => $11))
       RETURNING expires_at`,
      [
        handle, did, prepared.prevRoot, prepared.since, prepared.rev, Buffer.from(prepared.unsigned),
        JSON.stringify(prepared.newBlocks.map(([cid, bytes]) => [cid, Buffer.from(bytes).toString('base64')])),
        prepared.removedCids, JSON.stringify(prepared.indexOps), JSON.stringify(prepared.results),
        PENDING_COMMIT_TTL_SECONDS,
      ],
    );

    res.status(200).json({
      handle,
      did,
      rev: prepared.rev,
      prevRoot: prepared.prevRoot,
      unsignedCommit: Buffer.from(prepared.unsigned).toString('base64'),
      newBlocks: prepared.newBlocks.map(([cid, bytes]) => ({ cid, bytes: Buffer.from(bytes).toString('base64') })),
      writes: prepared.results,
      expiresAt: expires.rows[0].expires_at.toISOString(),
    });
  } catch (error) {
    renderXrpcError(NSID, res, error);
  }
}
