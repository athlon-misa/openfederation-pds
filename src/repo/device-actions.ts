/**
 * Device-signed actions (#240 phase 2, ADR-003 decision 14).
 *
 * With device signing on, the person's device holds the repo key, and the
 * server refuses every write it would have to sign for them. Phase 1 made the
 * generic record writes work through prepareCommit / submitCommit. The
 * features that write on the person's behalf (profile, contacts, forum posts,
 * RSVPs, votes, objections) do more than write a record: they check
 * permissions and state, and update indexes, tallies and notifications
 * afterwards. Reimplementing each of them as a "prepare" and a "finish" would
 * duplicate that logic and let the two drift apart. Instead the same handler
 * runs twice:
 *
 *  1. **prepare** (net.openfederation.repo.prepareAction): the handler runs as
 *     usual until the first point where it would sign for the person, a commit
 *     into their repo (`writeRepoAs`) or the author signature on a record kept
 *     in a private community's repo (`signAsAuthor`). There it stops, having
 *     changed nothing. What it was about to write is prepared for the device
 *     (an unsigned commit, or the record's CID) and stored with the method and
 *     its input, as for prepareCommit.
 *  2. **finish** (net.openfederation.repo.submitCommit with that handle): once
 *     the signature verifies against the DID's current `atproto` key, the
 *     handler runs again with the same input, checking everything again. At
 *     the same point it now gets the device-signed write instead of a
 *     server-signed one, and carries on (indexes, tallies, notifications).
 *     If the state changed so that it no longer reaches that point, nothing is
 *     applied and its answer is returned.
 *
 * The writes the device signs are the ones the server showed it, never the
 * second run's: a commit applies only on the root it was built on (so nothing
 * it was built from can have changed), and the second run must want the same
 * kind of write to the same records (`ActionChanged` otherwise). Only the
 * acting account's own repo is routed to the device; a write for any other
 * device-signing account is refused as before.
 */
import type { Request, Response } from 'express';
import { cidForRecord } from '@atproto/repo';
import { TID } from '@atproto/common-web';
import { query } from '../db/client.js';
import { RepoEngine, type BatchOp, type BatchResult } from './repo-engine.js';
import { RepoConcurrentWriteError } from './pg-blockstore.js';
import { getKeypairForDid } from './keypair-utils.js';
import { assertServerMaySign, DeviceSigningRequiredError } from './device-signing-state.js';
import {
  deviceActionStore, deviceActionContext, DeviceSignatureNeeded,
  type FinishContext, type PlannedAuthorRecord, type PrepareContext,
} from './device-action-context.js';
import { HttpError } from '../xrpc/errors.js';

export { DeviceSignatureNeeded, actingDevice, deviceActionContext } from './device-action-context.js';

/**
 * The methods a device can take part in through prepareAction. Each writes
 * at most once into the caller's own repo, or signs one record as its
 * author, and does so before any other change it makes.
 */
export const DEVICE_ACTION_METHODS: ReadonlySet<string> = new Set([
  'net.openfederation.account.updateProfile',
  'net.openfederation.forum.createThread',
  'net.openfederation.forum.createPost',
  'net.openfederation.forum.deletePost',
  'net.openfederation.calendar.rsvp',
  'net.openfederation.community.voteOnProposal',
  'net.openfederation.community.objectToProposal',
  'net.openfederation.contact.sendRequest',
  'net.openfederation.contact.respondToRequest',
  'net.openfederation.contact.removeContact',
  'net.openfederation.contact.withdrawRequest',
  'net.openfederation.contact.block',
  'net.openfederation.contact.unblock',
]);

export type RepoWriteResult = BatchResult[number] & { record?: Record<string, unknown> };

function isTid(rkey: string): boolean {
  return TID.is(rkey);
}

/**
 * Whether the second run's write can take the device-signed one's place:
 * the same action on the same collection, and the same record key, except
 * that a fresh record key (a TID with nothing stored under it yet) stands
 * for the one chosen in the first run.
 */
async function sameWrite(did: string, fresh: BatchOp, planned: BatchOp): Promise<boolean> {
  if (fresh.action !== planned.action || fresh.collection !== planned.collection) return false;
  if (fresh.rkey === planned.rkey) return true;
  if (fresh.action === 'delete' || !isTid(fresh.rkey) || !isTid(planned.rkey)) return false;
  const existing = await query(
    'SELECT 1 FROM records_index WHERE community_did = $1 AND collection = $2 AND rkey = $3',
    [did, fresh.collection, fresh.rkey],
  );
  return existing.rows.length === 0;
}

function actionChanged(): HttpError {
  return new HttpError(409, 'ActionChanged', 'What this action writes changed since it was prepared; prepare it again');
}

/**
 * Write into `did`'s repository, as `RepoEngine.applyWrites` does. When
 * `did`'s device is taking part in this request, the commit is the device's:
 * in prepare mode this stops the method (`DeviceSignatureNeeded`), in finish
 * mode it applies the commit the device signed. Otherwise the server signs,
 * which `RepoEngine` refuses for an account with device signing on.
 */
export async function writeRepoAs(did: string, ops: BatchOp[]): Promise<RepoWriteResult[]> {
  if (ops.length === 0) return [];
  const ctx = deviceActionContext();
  if (ctx?.mode === 'prepare' && ctx.needed) throw new DeviceSignatureNeeded();
  if (ctx && ctx.did === did) {
    if (ctx.mode === 'prepare') {
      ctx.needed = { kind: 'commit', ops };
      throw new DeviceSignatureNeeded();
    }
    return finishCommit(ctx, ops);
  }
  const results = await new RepoEngine(did).applyWrites(await getKeypairForDid(did), ops);
  return results.map((r, i) => {
    const op = ops[i];
    return op.action === 'write' ? { ...r, record: op.record } : r;
  });
}

async function finishCommit(ctx: FinishContext, ops: BatchOp[]): Promise<RepoWriteResult[]> {
  try {
    if (ctx.used || ctx.kind !== 'commit' || !ctx.prepared || !ctx.plannedOps) {
      throw new DeviceSigningRequiredError(ctx.did, 'This action needs a write the device did not sign; prepare it again');
    }
    const planned = ctx.plannedOps;
    if (ops.length !== planned.length) throw actionChanged();
    for (let i = 0; i < ops.length; i++) {
      if (!(await sameWrite(ctx.did, ops[i], planned[i]))) throw actionChanged();
    }
    const engine = new RepoEngine(ctx.did);
    if ((await engine.getRoot())?.toString() !== ctx.prepared.prevRoot) {
      throw new HttpError(409, 'RepoHeadMoved', 'The repository changed since this action was prepared; prepare it again');
    }
    ctx.used = true;
    try {
      ctx.commit = await engine.applyDeviceCommit(ctx.prepared, ctx.sig);
    } catch (err) {
      if (err instanceof RepoConcurrentWriteError) {
        throw new HttpError(409, 'RepoHeadMoved', 'The repository changed since this action was prepared; prepare it again');
      }
      throw err;
    }
    return ctx.prepared.results.map((r, i) => {
      const op = planned[i];
      return op.action === 'write' ? { ...r, record: op.record } : r;
    });
  } catch (err) {
    ctx.error ??= err;
    throw err;
  }
}

/**
 * The author's signature on a member record kept in another repository (a
 * private community's): `authorSig = { key, sig }`, the author's atproto key
 * over the CID of the record without it. When the author's device is taking
 * part in this request the device signs (prepare stops here; finish returns
 * the record the device signed, which may carry the rkey chosen in prepare).
 * Otherwise the server signs with the repo key it holds, which it refuses for
 * an account with device signing on.
 */
export async function signAsAuthor(p: {
  author: string;
  repo: string;
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
}): Promise<{ record: Record<string, unknown>; rkey: string }> {
  const { authorSig: _drop, ...rest } = p.record;
  const unsigned = { ...rest, author: p.author };
  const ctx = deviceActionContext();
  if (ctx?.mode === 'prepare' && ctx.needed) throw new DeviceSignatureNeeded();
  if (ctx && ctx.did === p.author) {
    if (ctx.mode === 'prepare') {
      ctx.needed = { kind: 'authorSig', planned: { repo: p.repo, collection: p.collection, rkey: p.rkey, record: unsigned } };
      throw new DeviceSignatureNeeded();
    }
    try {
      const planned = ctx.planned;
      if (ctx.used || ctx.kind !== 'authorSig' || !planned) {
        throw new DeviceSigningRequiredError(ctx.did, 'This action needs a signature the device did not make; prepare it again');
      }
      const fresh: BatchOp = { action: 'write', collection: p.collection, rkey: p.rkey, record: unsigned };
      const plannedOp: BatchOp = { action: 'write', collection: planned.collection, rkey: planned.rkey, record: planned.record };
      if (planned.repo !== p.repo || !(await sameWrite(p.repo, fresh, plannedOp))) throw actionChanged();
      ctx.used = true;
      const sig = Buffer.from(ctx.sig).toString('base64url');
      return { record: { ...planned.record, authorSig: { key: ctx.key, sig } }, rkey: planned.rkey };
    } catch (err) {
      ctx.error ??= err;
      throw err;
    }
  }
  await assertServerMaySign(p.author);
  const keypair = await getKeypairForDid(p.author);
  const cid = await cidForRecord(unsigned);
  const sig = Buffer.from(await keypair.sign(cid.bytes)).toString('base64url');
  return { record: { ...unsigned, authorSig: { key: keypair.did(), sig } }, rkey: p.rkey };
}

// ── Running a method in prepare or finish mode ────────────────────────────

/** Collects what a handler answers, without sending it. */
export class CapturedResponse {
  statusCode = 200;
  body: unknown = undefined;
  headersSent = false;
  status(code: number): this { this.statusCode = code; return this; }
  json(body: unknown): this { this.body = body; this.headersSent = true; return this; }
  send(body: unknown): this { this.body = body; this.headersSent = true; return this; }
  end(): this { this.headersSent = true; return this; }
  setHeader(): this { return this; }
  set(): this { return this; }
  header(): this { return this; }
  type(): this { return this; }
  getHeader(): undefined { return undefined; }
}

type Handler = (req: Request, res: Response) => Promise<void> | void;

async function entryFor(method: string) {
  // Imported when used: the registry imports the endpoints that import this module.
  const { handlerRegistry } = await import('../server/handler-registry.js');
  const entry = Object.hasOwn(handlerRegistry, method) ? handlerRegistry[method] : undefined;
  if (!entry || !DEVICE_ACTION_METHODS.has(method)) {
    throw new HttpError(400, 'UnsupportedMethod', `${method} cannot be signed on the device; see net.openfederation.repo.prepareAction`);
  }
  return entry;
}

async function handlerFor(method: string): Promise<Handler> {
  return (await entryFor(method)).handler as Handler;
}

/**
 * Apply `method`'s own rate limit to this request, as the router does when
 * the method is called directly, so preparing it through prepareAction is
 * not a way around it. False when the limiter has answered (limit reached).
 */
export async function applyMethodLimiter(method: string, req: Request, res: Response): Promise<boolean> {
  const { limiter } = await entryFor(method);
  if (!limiter) return true;
  await new Promise<void>((resolve, reject) => {
    limiter(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
  });
  return !res.headersSent;
}

/** The same request, with another body: what the method sees. */
function requestWith(req: Request, input: Record<string, unknown>): Request {
  const sub = Object.create(req) as Request;
  Object.defineProperty(sub, 'body', { value: input, writable: true, enumerable: true });
  return sub;
}

/** Run `method` with `input` until it needs the device (or finishes without it). */
export async function runPrepare(req: Request, did: string, method: string, input: Record<string, unknown>): Promise<{ ctx: PrepareContext; res: CapturedResponse }> {
  const handler = await handlerFor(method);
  const ctx: PrepareContext = { mode: 'prepare', did };
  const res = new CapturedResponse();
  await deviceActionStore.run(ctx, async () => {
    try {
      await handler(requestWith(req, input), res as unknown as Response);
    } catch (err) {
      if (!ctx.needed) throw err;
    }
  });
  return { ctx, res };
}

/** Run `method` again with the device's signature in place. */
export async function runFinish(req: Request, ctx: FinishContext, method: string, input: Record<string, unknown>): Promise<CapturedResponse> {
  const handler = await handlerFor(method);
  const res = new CapturedResponse();
  await deviceActionStore.run(ctx, async () => {
    try {
      await handler(requestWith(req, input), res as unknown as Response);
    } catch (err) {
      ctx.error ??= err;
    }
  });
  return res;
}

/**
 * Send what a method answered as is: its errors are its own (declared in its
 * lexicon, not in prepareAction's or submitCommit's), so they bypass the
 * output check of the method that forwards them.
 */
export function forwardResponse(res: Response, captured: CapturedResponse): void {
  res.status(captured.statusCode).type('application/json').send(JSON.stringify(captured.body ?? {}));
}

export type { PlannedAuthorRecord };
