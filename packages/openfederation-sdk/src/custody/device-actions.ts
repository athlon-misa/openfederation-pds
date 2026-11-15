/**
 * Device signing, phase 2 (#240): the features that write on the person's
 * behalf, signed on the device.
 *
 * With device signing on, the server can no longer sign anything for the
 * account. Record writes go through `deviceApplyWrites` (phase 1). The
 * features that do more than write a record (profile, contacts, forum posts,
 * RSVPs, votes, objections) go through `deviceAction`:
 *
 *   1. net.openfederation.repo.prepareAction runs the method on the PDS up to
 *      the write the device must sign, and returns it unsigned: a commit into
 *      the person's repo, or (in a private community, whose content is kept
 *      in the community's repo) the record to sign as its author;
 *   2. the device checks it: for a commit, the new tree holds exactly the
 *      previous records plus these writes (`verifyPreparedCommit`), and the
 *      records say what was asked for (`expect`); for an author signature, the
 *      record names this DID as author, says what was asked for, and its CID
 *      is the one computed here;
 *   3. the device signs, and net.openfederation.repo.submitCommit runs the
 *      method again with the signature in place and returns its answer.
 *
 *   await deviceCreatePost({ client, did, deviceKey, verifyAgainst: pdsUrl,
 *     community, root: { uri, cid }, text: 'Hello' });
 *
 * Tokens are signed on the device without the PDS's help where possible:
 * `createServiceAuthToken` mints the service-auth JWT AT Protocol checks
 * against the DID's atproto key (com.atproto.server.getServiceAuth refuses for
 * such accounts), and `deviceSignInAssert` signs the SIWOF didToken the PDS
 * prepared, after checking its claims against the message.
 */
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base64UrlEncode, base64UrlDecode } from './encoding.js';
import {
  verifyPreparedCommit, signCommitBytes, repoRecordCid, DeviceCommitRejected,
  type DeviceWrite, type PreparedCommit, type XrpcCaller,
} from './device-signing.js';

type Fetch = typeof globalThis.fetch;

export const FORUM_THREAD_COLLECTION = 'net.openfederation.forum.thread';
export const FORUM_POST_COLLECTION = 'net.openfederation.forum.post';
export const CALENDAR_RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';
export const VOTE_COLLECTION = 'net.openfederation.governance.vote';
export const OBJECTION_COLLECTION = 'net.openfederation.governance.objection';
export const CONTACT_REQUEST_COLLECTION = 'net.openfederation.contact.request';
export const CONTACT_COLLECTION = 'net.openfederation.contact.contact';
export const CONTACT_BLOCK_COLLECTION = 'net.openfederation.contact.block';
export const PROFILE_COLLECTION = 'app.bsky.actor.profile';

/** A planned write, as prepareAction returns it. */
export type PlannedWrite =
  | { action: 'create' | 'update'; collection: string; rkey: string; record: Record<string, unknown> }
  | { action: 'delete'; collection: string; rkey: string };

/** What prepareAction returns. */
export interface DeviceActionRequest {
  method: string;
  kind: 'commit' | 'authorSig' | 'none';
  handle?: string;
  expiresAt?: string;
  /** kind commit. */
  commit?: PreparedCommit;
  writes?: PlannedWrite[];
  /** kind authorSig. */
  authorSig?: { repo: string; collection: string; rkey: string; record: Record<string, unknown>; cid: string };
  /** kind none: the method's answer. */
  result?: unknown;
}

export interface DeviceActionResult<T = unknown> {
  /** The method's answer, as it returns it when the server signs. */
  result: T;
  /** Whether the device signed anything (false when the method needed no signature after all). */
  signed: boolean;
  commit?: { cid: string; rev: string };
  writes?: Array<{ collection: string; rkey: string; uri: string; cid?: string }>;
}

export interface DeviceActionOptions {
  client: XrpcCaller;
  did: string;
  /** The device's repo key (secp256k1 private key). */
  deviceKey: Uint8Array;
  /**
   * A base URL serving com.atproto.sync.getRepo for the account (its PDS, or a
   * relay), to check a prepared commit's tree. Not needed for an author
   * signature. Pass `skipTreeCheck: true` only to sign whatever the server
   * prepared.
   */
  verifyAgainst?: string;
  skipTreeCheck?: boolean;
  /**
   * did:keys of this device and the person's earlier device keys: refuse to
   * sign a commit on top of a head none of them signed (`UntrustedHead`; see
   * verifyPreparedCommit). Pass it after the first device write.
   */
  trustedHeadKeys?: string[];
  /** Tries when the repository moved, or the action changed, in between (default 3). */
  attempts?: number;
  fetch?: Fetch;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32Decode(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0; let value = 0;
  for (const ch of text) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return new Uint8Array(out);
}
function base64Decode(text: string): Uint8Array {
  return base64UrlDecode(text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}
function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
/** The binary form of a `b…` (base32, CIDv1) CID: the bytes an author signature covers. */
export function cidBytes(cid: string): Uint8Array {
  if (!cid.startsWith('b')) throw new Error('Only base32 CIDs are supported');
  return base32Decode(cid.slice(1));
}

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; error?: unknown } | null;
  return typeof e?.code === 'string' ? e.code : typeof e?.error === 'string' ? e.error : undefined;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Sign an author signature request on the device: the record must name `did`
 * as its author, carry no signature yet, and have exactly the CID the server
 * gave. Returns the 64-byte signature over the CID's bytes.
 */
export function signAuthorRecord(did: string, request: NonNullable<DeviceActionRequest['authorSig']>, deviceKey: Uint8Array): Uint8Array {
  if (request.record.author !== did) throw new DeviceCommitRejected('The record does not name this account as its author');
  if ('authorSig' in request.record) throw new DeviceCommitRejected('The record already carries a signature');
  if (repoRecordCid(request.record) !== request.cid) throw new DeviceCommitRejected('The record does not match its CID');
  return signCommitBytes(cidBytes(request.cid), deviceKey);
}

/**
 * Run `method` with `input` on the PDS, with the device signing the write it
 * makes for the person (see the module note). `expect` checks what the server
 * plans to write before anything is signed; throw (DeviceCommitRejected) to
 * refuse. Retries on RepoHeadMoved and ActionChanged.
 */
export async function deviceAction<T = unknown>(p: DeviceActionOptions & {
  method: string;
  input: Record<string, unknown>;
  expect?: (request: DeviceActionRequest) => void;
}): Promise<DeviceActionResult<T>> {
  const attempts = Math.max(1, p.attempts ?? 3);
  for (let attempt = 1; ; attempt++) {
    const request = await p.client.fetch('net.openfederation.repo.prepareAction', {
      method: 'POST', body: { method: p.method, input: p.input },
    }) as DeviceActionRequest;
    if (request.method !== p.method) throw new DeviceCommitRejected('The server prepared another method');
    if (request.kind === 'none') return { result: request.result as T, signed: false };

    let sig: Uint8Array;
    if (request.kind === 'commit') {
      if (!request.commit || !request.writes) throw new DeviceCommitRejected('The prepared commit is incomplete');
      p.expect?.(request);
      if (!p.skipTreeCheck) {
        if (!p.verifyAgainst) throw new Error('Pass verifyAgainst (a URL serving com.atproto.sync.getRepo) or skipTreeCheck: true');
        const doFetch = p.fetch ?? ((...args: Parameters<Fetch>) => globalThis.fetch(...args));
        const res = await doFetch(`${p.verifyAgainst.replace(/\/+$/, '')}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(p.did)}`);
        if (!res.ok) throw new Error(`Could not read the repository to check the commit (${res.status})`);
        verifyPreparedCommit({
          did: p.did, prepared: request.commit, writes: request.writes as DeviceWrite[],
          previousCar: new Uint8Array(await res.arrayBuffer()), trustedHeadKeys: p.trustedHeadKeys,
        });
      }
      sig = signCommitBytes(base64Decode(request.commit.unsignedCommit), p.deviceKey);
    } else if (request.kind === 'authorSig') {
      if (!request.authorSig) throw new DeviceCommitRejected('The author signature request is incomplete');
      p.expect?.(request);
      sig = signAuthorRecord(p.did, request.authorSig, p.deviceKey);
    } else {
      throw new DeviceCommitRejected(`Unknown kind: ${String(request.kind)}`);
    }

    try {
      return await p.client.fetch('net.openfederation.repo.submitCommit', {
        method: 'POST', body: { handle: request.handle!, sig: base64Encode(sig) },
      }) as DeviceActionResult<T>;
    } catch (err) {
      const code = errorCode(err);
      if ((code !== 'RepoHeadMoved' && code !== 'ActionChanged') || attempt >= attempts) throw err;
    }
  }
}

// ── What each feature may write ─────────────────────────────────────────────

/** The records the server plans to write, wherever they go (own repo, or signed for a community's). */
function plannedRecords(request: DeviceActionRequest): Array<{ collection: string; rkey: string; record: Record<string, unknown> }> {
  if (request.kind === 'authorSig' && request.authorSig) {
    const a = request.authorSig;
    return [{ collection: a.collection, rkey: a.rkey, record: a.record }];
  }
  return (request.writes ?? []).flatMap((w) => (w.action === 'delete' ? [] : [{ collection: w.collection, rkey: w.rkey, record: w.record }]));
}

function plannedDeletes(request: DeviceActionRequest): Array<{ collection: string; rkey: string }> {
  return request.kind === 'commit' ? (request.writes ?? []).filter((w) => w.action === 'delete') : [];
}

/**
 * Refuse unless the server plans exactly one record in `collection` (and
 * nothing else, apart from the deletes `allowDeletes` permits) whose fields
 * include `fields`.
 */
export function expectOneRecord(collection: string, fields: Record<string, unknown>, opts: { allowDeletes?: (d: { collection: string; rkey: string }) => boolean } = {}) {
  return (request: DeviceActionRequest): void => {
    const records = plannedRecords(request);
    if (records.length !== 1 || records[0].collection !== collection) {
      throw new DeviceCommitRejected(`Expected one ${collection} record, the server planned ${records.map((r) => r.collection).join(', ') || 'none'}`);
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (!same(records[0].record[key], value)) throw new DeviceCommitRejected(`The ${collection} record's ${key} is not what was asked for`);
    }
    for (const d of plannedDeletes(request)) {
      if (!opts.allowDeletes?.(d)) throw new DeviceCommitRejected(`The server also planned to delete ${d.collection}/${d.rkey}`);
    }
  };
}

/** Refuse unless the server plans only deletes, each allowed by `allow`, and at most `max` of them. */
export function expectDeletes(allow: (d: { collection: string; rkey: string }) => boolean, max = 1) {
  return (request: DeviceActionRequest): void => {
    if (plannedRecords(request).length > 0) throw new DeviceCommitRejected('The server planned to write a record; only a deletion was asked for');
    const deletes = plannedDeletes(request);
    if (deletes.length === 0 || deletes.length > max) throw new DeviceCommitRejected(`Expected ${max === 1 ? 'one deletion' : `up to ${max} deletions`}, the server planned ${deletes.length}`);
    for (const d of deletes) if (!allow(d)) throw new DeviceCommitRejected(`The server planned to delete ${d.collection}/${d.rkey}`);
  };
}

type Opts = DeviceActionOptions;

/** net.openfederation.account.updateProfile, signed on the device. */
export function deviceUpdateProfile(p: Opts & {
  displayName?: string;
  description?: string;
  avatar?: unknown;
  banner?: unknown;
  /** A custom profile collection (e.g. app.example.actor.profile) with its whole record. */
  collection?: string;
  record?: Record<string, unknown>;
}) {
  const input: Record<string, unknown> = {};
  for (const k of ['displayName', 'description', 'avatar', 'banner', 'collection', 'record'] as const) {
    if (p[k] !== undefined) input[k] = p[k];
  }
  const collection = p.collection ?? PROFILE_COLLECTION;
  const fields = p.collection && p.record ? p.record : {
    displayName: p.displayName, description: p.description,
    ...(p.avatar ? { avatar: p.avatar } : {}), ...(p.banner ? { banner: p.banner } : {}),
  };
  return deviceAction<{ uri: string; cid: string }>({
    ...p, method: 'net.openfederation.account.updateProfile', input,
    expect: (request) => {
      expectOneRecord(collection, fields)(request);
      const [r] = plannedRecords(request);
      if (r.rkey !== 'self') throw new DeviceCommitRejected('A profile is the record at rkey self');
      for (const k of ['avatar', 'banner'] as const) {
        if (p[k] === null && k in r.record) throw new DeviceCommitRejected(`The profile still has its ${k}`);
      }
    },
  });
}

/** net.openfederation.forum.createThread, signed on the device (a public community's thread goes in the person's repo; a private one's is signed as its author). */
export function deviceCreateThread(p: Opts & { community: string; title: string; tags?: string[] }) {
  return deviceAction<{ uri: string; cid: string; rkey: string }>({
    ...p, method: 'net.openfederation.forum.createThread',
    input: { community: p.community, title: p.title, ...(p.tags ? { tags: p.tags } : {}) },
    expect: expectOneRecord(FORUM_THREAD_COLLECTION, { community: p.community, title: p.title.trim() }),
  });
}

/** net.openfederation.forum.createPost, signed on the device. */
export function deviceCreatePost(p: Opts & { community: string; root: { uri: string; cid: string }; parent?: { uri: string; cid: string }; text: string }) {
  return deviceAction<{ uri: string; cid: string; rkey: string }>({
    ...p, method: 'net.openfederation.forum.createPost',
    input: { community: p.community, root: p.root, text: p.text, ...(p.parent ? { parent: p.parent } : {}) },
    expect: expectOneRecord(FORUM_POST_COLLECTION, { community: p.community, root: p.root, text: p.text.trim(), parent: p.parent }),
  });
}

/**
 * net.openfederation.forum.deletePost, signed on the device when the post is
 * in the person's repo (a post kept in a private community's repo is deleted
 * by the community's key, and needs no signature).
 */
export function deviceDeletePost(p: Opts & { rkey: string }) {
  return deviceAction<{ success: boolean }>({
    ...p, method: 'net.openfederation.forum.deletePost', input: { rkey: p.rkey },
    expect: expectDeletes((d) => d.collection === FORUM_POST_COLLECTION && d.rkey === p.rkey),
  });
}

/** net.openfederation.calendar.rsvp, signed on the device. */
export function deviceRsvp(p: Opts & { community: string; event: { uri: string; cid: string }; status: 'going' | 'interested' | 'notgoing' }) {
  return deviceAction<{ uri: string; cid: string; rkey: string }>({
    ...p, method: 'net.openfederation.calendar.rsvp',
    input: { community: p.community, event: p.event, status: p.status },
    expect: expectOneRecord(CALENDAR_RSVP_COLLECTION, { subject: p.event, status: p.status }),
  });
}

/** net.openfederation.community.voteOnProposal: the person's vote record, signed on the device. */
export function deviceVote(p: Opts & { communityDid: string; proposalRkey: string; vote: 'for' | 'against' }) {
  return deviceAction<Record<string, unknown>>({
    ...p, method: 'net.openfederation.community.voteOnProposal',
    input: { communityDid: p.communityDid, proposalRkey: p.proposalRkey, vote: p.vote },
    expect: (request) => {
      expectOneRecord(VOTE_COLLECTION, { community: p.communityDid, proposalRkey: p.proposalRkey, vote: p.vote })(request);
      if ('castBy' in plannedRecords(request)[0].record) throw new DeviceCommitRejected('A direct vote is not cast by anyone else');
    },
  });
}

/** net.openfederation.community.objectToProposal: the person's objection record, signed on the device. */
export function deviceObject(p: Opts & { communityDid: string; proposalRkey: string; reason?: string }) {
  return deviceAction<Record<string, unknown>>({
    ...p, method: 'net.openfederation.community.objectToProposal',
    input: { communityDid: p.communityDid, proposalRkey: p.proposalRkey, ...(p.reason ? { reason: p.reason } : {}) },
    expect: expectOneRecord(OBJECTION_COLLECTION, { community: p.communityDid, proposalRkey: p.proposalRkey, reason: p.reason }),
  });
}

/** net.openfederation.contact.sendRequest: the request record, signed on the device. */
export function deviceSendContactRequest(p: Opts & { subject: string; note?: string }) {
  return deviceAction<{ rkey: string; uri: string; cid: string }>({
    ...p, method: 'net.openfederation.contact.sendRequest',
    input: { subject: p.subject, ...(p.note ? { note: p.note } : {}) },
    expect: expectOneRecord(CONTACT_REQUEST_COLLECTION, { subject: p.subject, note: p.note }),
  });
}

/**
 * net.openfederation.contact.respondToRequest. Accepting writes the person's
 * contact record, signed on the device; rejecting writes nothing of theirs.
 * Pass `from` (the requester's DID) to check the contact record names them.
 */
export function deviceRespondToContactRequest(p: Opts & { rkey: string; action: 'accept' | 'reject'; from?: string }) {
  return deviceAction<{ success: boolean }>({
    ...p, method: 'net.openfederation.contact.respondToRequest', input: { rkey: p.rkey, action: p.action },
    expect: (request) => {
      if (p.action !== 'accept') throw new DeviceCommitRejected('Rejecting a request writes nothing of the person\'s');
      expectOneRecord(CONTACT_COLLECTION, { subject: p.from })(request);
    },
  });
}

/** net.openfederation.contact.removeContact: deleting the person's contact record, signed on the device. */
export function deviceRemoveContact(p: Opts & { subject: string }) {
  return deviceAction<{ success: boolean }>({
    ...p, method: 'net.openfederation.contact.removeContact', input: { subject: p.subject },
    expect: expectDeletes((d) => d.collection === CONTACT_COLLECTION),
  });
}

/** net.openfederation.contact.withdrawRequest: deleting the person's request record, signed on the device. */
export function deviceWithdrawContactRequest(p: Opts & { rkey: string }) {
  return deviceAction<{ success: boolean }>({
    ...p, method: 'net.openfederation.contact.withdrawRequest', input: { rkey: p.rkey },
    expect: expectDeletes((d) => d.collection === CONTACT_REQUEST_COLLECTION && d.rkey === p.rkey),
  });
}

/**
 * net.openfederation.contact.block: one commit on the device, holding the
 * block record and the deletion of the person's contact record and request
 * naming the subject, if any.
 */
export function deviceBlockContact(p: Opts & { subject: string }) {
  const removable = (d: { collection: string }) => d.collection === CONTACT_COLLECTION || d.collection === CONTACT_REQUEST_COLLECTION;
  return deviceAction<{ success: boolean }>({
    ...p, method: 'net.openfederation.contact.block', input: { subject: p.subject },
    expect: (request) => {
      if (plannedRecords(request).length === 0) {
        // Already blocked: only the cleanup is left.
        expectDeletes(removable, 2)(request);
        return;
      }
      expectOneRecord(CONTACT_BLOCK_COLLECTION, { subject: p.subject }, { allowDeletes: removable })(request);
      if (plannedDeletes(request).length > 2) throw new DeviceCommitRejected('The server planned too many deletions');
    },
  });
}

/** net.openfederation.contact.unblock: deleting the person's block record, signed on the device. */
export function deviceUnblockContact(p: Opts & { subject: string }) {
  return deviceAction<{ success: boolean }>({
    ...p, method: 'net.openfederation.contact.unblock', input: { subject: p.subject },
    expect: expectDeletes((d) => d.collection === CONTACT_BLOCK_COLLECTION),
  });
}

// ── Tokens signed on the device ─────────────────────────────────────────────

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Sign a JWT's `header.payload` with the device key (ES256K: ECDSA over SHA-256, compact, low-S) and return the token. */
export function signJwtOnDevice(signingInput: string, deviceKey: Uint8Array): string {
  const sig = secp256k1.sign(sha256(utf8(signingInput)), deviceKey, { lowS: true }).toCompactRawBytes();
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

function randomJti(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * An AT Protocol service-auth JWT signed with the device's repo key, for an
 * account with device signing on (com.atproto.server.getServiceAuth refuses
 * for it: the token is checked against the DID's atproto key, which is the
 * device's). Same claims as the PDS mints: iss = the DID, aud = the service
 * DID, exp (default 60 s), iat, a random jti, and lxm when given.
 */
export function createServiceAuthToken(p: {
  did: string;
  deviceKey: Uint8Array;
  aud: string;
  lxm?: string;
  /** Unix seconds; default now + 60. */
  exp?: number;
  extraClaims?: Record<string, unknown>;
}): string {
  if (!p.aud.startsWith('did:')) throw new Error('aud must be a DID');
  const now = Math.floor(Date.now() / 1000);
  const exp = p.exp ?? now + 60;
  if (exp <= now) throw new Error('exp must be in the future');
  const header = { typ: 'JWT', alg: 'ES256K' };
  const payload = { ...(p.extraClaims ?? {}), iss: p.did, aud: p.aud, exp, iat: now, jti: randomJti(), ...(p.lxm ? { lxm: p.lxm } : {}) };
  const signingInput = `${base64UrlEncode(utf8(JSON.stringify(header)))}.${base64UrlEncode(utf8(JSON.stringify(payload)))}`;
  return signJwtOnDevice(signingInput, p.deviceKey);
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as Record<string, unknown>;
}

/** The value of a `Key: value` line of a SIWOF (CAIP-122) message. */
function messageLine(message: string, key: string): string | undefined {
  const line = message.split('\n').find((l) => l.startsWith(`${key}: `));
  return line?.slice(key.length + 2);
}

function siwofAudience(raw: string): string {
  const url = new URL(raw);
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname === '/' ? '' : url.pathname}`;
}

/**
 * net.openfederation.identity.signInAssert for an account with device
 * signing on: the PDS checks the wallet signature and the challenge as usual
 * and returns the didToken unsigned; this checks its claims against the
 * message (issuer, audience, nonce, account, chain, expiry, method) and signs
 * it with the device key. Returns the endpoint's answer with `didToken` filled in.
 */
export async function deviceSignInAssert(p: {
  client: XrpcCaller;
  did: string;
  deviceKey: Uint8Array;
  chain: 'ethereum' | 'solana';
  walletAddress: string;
  message: string;
  walletSignature: string;
}): Promise<{ didToken: string; walletProof: Record<string, unknown>; did: string; audience: string }> {
  const res = await p.client.fetch('net.openfederation.identity.signInAssert', {
    method: 'POST',
    body: { chain: p.chain, walletAddress: p.walletAddress, message: p.message, walletSignature: p.walletSignature, signOnDevice: true },
  }) as { unsignedDidToken?: string; didToken?: string; walletProof: Record<string, unknown>; did: string; audience: string };
  if (!res.unsignedDidToken) throw new DeviceCommitRejected('The server did not return a token to sign');
  const [h, b, extra] = res.unsignedDidToken.split('.');
  if (!h || !b || extra !== undefined) throw new DeviceCommitRejected('The token to sign is malformed');
  const header = decodeJwtPart(h);
  const claims = decodeJwtPart(b);
  const reject = (what: string): never => { throw new DeviceCommitRejected(`The didToken's ${what} does not match the sign-in`); };
  if (header.alg !== 'ES256K' || header.typ !== 'JWT') reject('header');
  if (claims.iss !== p.did || res.did !== p.did) reject('issuer');
  const uri = messageLine(p.message, 'URI');
  if (!uri || claims.aud !== siwofAudience(uri) || res.audience !== claims.aud) reject('audience');
  if (claims.nonce !== messageLine(p.message, 'Nonce')) reject('nonce');
  const chainId = messageLine(p.message, 'Chain ID');
  if (claims.chainIdCaip2 !== chainId) reject('chain');
  const address = p.message.split('\n')[1]?.trim();
  if (!address || claims.sub !== `${chainId}:${address}`) reject('account');
  const walletAddress = p.chain === 'ethereum' ? p.walletAddress.toLowerCase() : p.walletAddress;
  if (claims.walletAddress !== walletAddress || claims.chain !== p.chain) reject('wallet');
  const expiry = messageLine(p.message, 'Expiration Time');
  if (!expiry || claims.exp !== Math.floor(Date.parse(expiry) / 1000)) reject('expiry');
  if (claims.lxm !== 'net.openfederation.identity.signInAssert') reject('method');
  const didToken = signJwtOnDevice(res.unsignedDidToken, p.deviceKey);
  return { didToken, walletProof: res.walletProof, did: res.did, audience: res.audience };
}
