/**
 * Repo monitoring (#241): notice writes the person's own device did not make.
 *
 * The PDS holds the repo signing key, so its operator can commit records as
 * the user. Repositories are public (com.atproto.sync.*), so a client can
 * keep a list of the writes its own device made and compare it with what the
 * repository actually holds:
 *
 *   const watcher = new RepoWatcher({ source: 'https://pds.example', storage: new LocalStorageAdapter() });
 *   await watcher.check(did);                               // first call: records a baseline
 *   await watcher.write(client, 'com.atproto.repo.createRecord', { repo: did, collection, record });
 *   const result = await watcher.check(did);                // 'clean' or 'unknown-changes'
 *
 * A hostile PDS can show the client that asks it a different repository from
 * the one it shows everyone else. Point `source` at another copy (a relay or
 * mirror that serves com.atproto.sync.getLatestCommit and getRepo) to check
 * what the rest of the network sees.
 *
 * Polling sees the repository's current state, not every commit: several
 * commits between two checks are reported together, and a forged write that
 * was undone before the next check is not seen. Follow the firehose
 * (com.atproto.sync.subscribeRepos) and call check() on every new commit for
 * a complete record.
 */
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { p256 } from '@noble/curves/p256';
import { base32Lower, base64UrlEncode, parseDidKey } from './encoding.js';
import { MemoryStorageAdapter, type StorageAdapter } from '../storage.js';

// ── CAR and repository reading ───────────────────────────────────

interface CidLike { toString(): string }

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0; let shift = 0; let p = pos;
  for (;;) {
    if (p >= buf.length || shift > 49) throw new Error('Malformed CAR: bad varint');
    const b = buf[p++];
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [value, p];
    shift += 7;
  }
}

/** Parse one CIDv1 at `pos`; returns its string form and where the next field starts. */
function readCid(buf: Uint8Array, pos: number): { cid: string; end: number; hashCode: number; digest: Uint8Array } {
  if (buf[pos] === 0x12 && buf[pos + 1] === 0x20) throw new Error('Malformed CAR: CIDv0 blocks are not supported');
  let p = pos; let version: number; let hashCode: number; let len: number;
  [version, p] = readVarint(buf, p);
  if (version !== 1) throw new Error('Malformed CAR: unsupported CID version');
  [, p] = readVarint(buf, p); // codec
  [hashCode, p] = readVarint(buf, p);
  [len, p] = readVarint(buf, p);
  const end = p + len;
  if (end > buf.length) throw new Error('Malformed CAR: truncated CID');
  return { cid: `b${base32Lower(buf.subarray(pos, end))}`, end, hashCode, digest: buf.subarray(p, end) };
}

/** Read a CARv1 file: its roots and its blocks by CID. Every sha-256 block is checked against its CID. */
export function readCar(car: Uint8Array): { roots: string[]; blocks: Map<string, Uint8Array> } {
  const [headerLen, start] = readVarint(car, 0);
  const header = dagCbor.decode(car.subarray(start, start + headerLen)) as { version?: number; roots?: CidLike[] };
  if (header.version !== 1 || !Array.isArray(header.roots)) throw new Error('Malformed CAR: not a CARv1 file');
  const blocks = new Map<string, Uint8Array>();
  let pos = start + headerLen;
  while (pos < car.length) {
    const [len, p] = readVarint(car, pos);
    const end = p + len;
    if (end > car.length) throw new Error('Malformed CAR: truncated block');
    const { cid, end: dataStart, hashCode, digest } = readCid(car, p);
    const data = car.subarray(dataStart, end);
    if (hashCode === 0x12) {
      const actual = sha256(data);
      if (actual.length !== digest.length || actual.some((b, i) => b !== digest[i])) {
        throw new Error(`Malformed CAR: block ${cid} does not match its CID`);
      }
    }
    blocks.set(cid, data);
    pos = end;
  }
  return { roots: header.roots.map((r) => r.toString()), blocks };
}

/** A signed repository commit (AT Protocol repo v3). */
export interface RepoCommit {
  did: string;
  rev: string;
  /** CID of the commit block itself. */
  cid: string;
  /** CID of the MST root. */
  data: string;
  version: number;
  prev: string | null;
  /** The signature, base64url. */
  sig: string;
  /** The commit block as served, kept as evidence. verifyRepoCommit checks it. */
  block: Uint8Array;
}

interface MstNode { l: CidLike | null; e: Array<{ p: number; k: Uint8Array; v: CidLike; t: CidLike | null }> }

/**
 * Read a repository CAR (com.atproto.sync.getRepo): its signed commit and
 * every record path (`collection/rkey`) with the record's CID.
 */
export function readRepoCar(car: Uint8Array): { commit: RepoCommit; records: Map<string, string> } {
  const { roots, blocks } = readCar(car);
  if (roots.length !== 1) throw new Error('A repository CAR has exactly one root');
  const block = blocks.get(roots[0]);
  if (!block) throw new Error('The CAR does not contain its root commit');
  const raw = dagCbor.decode(block) as { did: string; rev: string; data: CidLike; version: number; prev?: CidLike | null; sig: Uint8Array };
  if (typeof raw.did !== 'string' || typeof raw.rev !== 'string' || !raw.data || !(raw.sig instanceof Uint8Array)) {
    throw new Error('The CAR root is not a repository commit');
  }
  const commit: RepoCommit = {
    did: raw.did, rev: raw.rev, cid: roots[0], data: raw.data.toString(), version: raw.version,
    prev: raw.prev ? raw.prev.toString() : null, sig: base64UrlEncode(raw.sig), block,
  };

  return { commit, records: listMstRecords(blocks, commit.data) };
}

/**
 * Every record path (`collection/rkey`) in a repository tree, with the
 * record's CID, walking from the MST root `dataCid` through `blocks`.
 * With `strict`, the paths must come out in strictly increasing order, as
 * they do in any well-formed tree (a tree with a key twice, or out of order,
 * could read differently elsewhere).
 */
export function listMstRecords(blocks: Map<string, Uint8Array>, dataCid: string, strict = false): Map<string, string> {
  const records = new Map<string, string>();
  const decoder = new TextDecoder();
  let visited = 0;
  let previous: string | null = null;
  const walk = (cid: string) => {
    if (++visited > blocks.size) throw new Error('Malformed repository: the tree loops');
    const bytes = blocks.get(cid);
    if (!bytes) throw new Error(`The CAR is missing tree node ${cid}`);
    const node = dagCbor.decode(bytes) as MstNode;
    if (node.l) walk(node.l.toString());
    let last = new Uint8Array(0);
    for (const e of node.e ?? []) {
      const key = new Uint8Array(e.p + e.k.length);
      key.set(last.subarray(0, e.p)); key.set(e.k, e.p);
      last = key;
      const path = decoder.decode(key);
      if (strict && previous !== null && !(path > previous)) throw new Error('Malformed repository: tree keys out of order');
      previous = path;
      records.set(path, e.v.toString());
      if (e.t) walk(e.t.toString());
    }
  };
  walk(dataCid);
  return records;
}

/**
 * Check a commit's signature against a did:key (secp256k1 or P-256). Use
 * the DID document's `atproto` key at the time of the commit: a valid
 * signature shows that key's holder (the PDS) made the commit.
 */
export function verifyRepoCommit(commit: Pick<RepoCommit, 'block'>, atprotoDidKey: string): boolean {
  const raw = dagCbor.decode(commit.block) as Record<string, unknown> & { sig?: Uint8Array };
  const { sig, ...unsigned } = raw;
  if (!(sig instanceof Uint8Array)) return false;
  try {
    const { curve, publicKey } = parseDidKey(atprotoDidKey);
    const c = curve === 'secp256k1' ? secp256k1 : p256;
    return c.verify(sig, sha256(dagCbor.encode(unsigned)), publicKey, { lowS: true });
  } catch {
    return false;
  }
}

const S32 = '234567abcdefghijklmnopqrstuvwxyz';
/**
 * The time a revision (a TID) names, as ISO 8601, or null if it is not a
 * TID. The PDS picks the revision, so this is the time it claims.
 */
export function revToTime(rev: string): string | null {
  if (!/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(rev)) return null;
  let value = 0n;
  for (const ch of rev) value = value * 32n + BigInt(S32.indexOf(ch));
  const micros = value >> 10n;
  const date = new Date(Number(micros / 1000n));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ── The watcher ──────────────────────────────────────────────────

export interface CommitRef { rev: string; cid: string }

export interface RepoChange {
  /** `collection/rkey` */
  path: string;
  collection: string;
  rkey: string;
  action: 'create' | 'update' | 'delete';
  /** The record CID the repository holds now; null for a delete. */
  cid: string | null;
  /** The CID this device expected; null when it expected no record. */
  expectedCid: string | null;
}

export interface UnknownCommit extends CommitRef {
  /** The time the revision claims (the PDS picks it). */
  time: string | null;
  /** The last commit this device checked and found as expected; the changes happened after it. */
  since: CommitRef | null;
  changes: RepoChange[];
  /** The signed commit, as evidence (verifyRepoCommit). */
  commit: RepoCommit;
}

export interface RepoCheckResult {
  did: string;
  source: string;
  /**
   * `baseline`: first check, the current state was recorded as expected.
   * `clean`: the repository holds exactly what this device expects.
   * `unknown-changes`: it holds records this device did not write (or lacks ones it did).
   */
  status: 'baseline' | 'clean' | 'unknown-changes';
  latest: CommitRef & { time: string | null; own: boolean };
  /**
   * Empty unless status is `unknown-changes`. A check sees only the current
   * commit, so it reports one entry holding every unexplained change since
   * `since`; several forged commits between two checks appear as one.
   */
  unknownCommits: UnknownCommit[];
  /** The repository CAR as served, when it was downloaded. Keep it as evidence. */
  car?: Uint8Array;
}

export interface OwnWrite {
  action: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  /** The record's CID, as the write call returned it. Required for create and update. */
  cid?: string;
}

export interface OwnCommit {
  rev?: string;
  /** The commit CID, when the PDS returned one (`commit.cid` in the write output). */
  cid?: string;
  writes: OwnWrite[];
}

/** Anything with the SDK client's `fetch(nsid, { method, body })`. */
export interface XrpcWriter {
  fetch(nsid: string, opts: { method: 'POST'; body: Record<string, unknown> }): Promise<unknown>;
}

export interface RepoWatcherOptions {
  /**
   * Base URL that serves com.atproto.sync.getLatestCommit and getRepo for the
   * account: its PDS, or (better against a hostile PDS) a relay or mirror.
   */
  source: string;
  /** Where the expected state is kept. Default: in memory. In a browser, LocalStorageAdapter. */
  storage?: StorageAdapter;
  /** Only report changes in these collections (e.g. `['app.bsky.feed.post']`). Default: all. */
  collections?: string[];
  fetch?: typeof globalThis.fetch;
  /** Storage key prefix. Default `of_repo_watch:`. */
  keyPrefix?: string;
}

interface WatchState {
  v: 1;
  baselined: boolean;
  /** path → record CID this device expects. */
  expected: Record<string, string>;
  /** The last commit found as expected. */
  verified: CommitRef | null;
  /** CIDs of commits this device made (most recent last, capped). */
  own: string[];
}

const MAX_OWN = 500;
const WRITE_NSIDS = new Set([
  'com.atproto.repo.createRecord', 'com.atproto.repo.putRecord', 'com.atproto.repo.deleteRecord', 'com.atproto.repo.applyWrites',
]);

function splitPath(path: string): { collection: string; rkey: string } {
  const i = path.indexOf('/');
  return { collection: path.slice(0, i), rkey: path.slice(i + 1) };
}

function parseAtUri(uri: unknown): { did: string; collection: string; rkey: string } | null {
  if (typeof uri !== 'string') return null;
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  return m ? { did: m[1], collection: m[2], rkey: m[3] } : null;
}

export class RepoWatcher {
  private readonly source: string;
  private readonly storage: StorageAdapter;
  private readonly collections: Set<string> | null;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly prefix: string;

  constructor(opts: RepoWatcherOptions) {
    if (!opts?.source) throw new Error('RepoWatcher needs a source URL');
    this.source = opts.source.replace(/\/+$/, '');
    this.storage = opts.storage ?? new MemoryStorageAdapter();
    this.collections = opts.collections ? new Set(opts.collections) : null;
    this.fetchFn = opts.fetch ?? ((...args) => globalThis.fetch(...args));
    this.prefix = opts.keyPrefix ?? 'of_repo_watch:';
  }

  private load(did: string): WatchState | null {
    const text = this.storage.get(this.prefix + did);
    if (!text) return null;
    try {
      const s = JSON.parse(text) as WatchState;
      return s && s.v === 1 ? s : null;
    } catch {
      return null;
    }
  }

  private save(did: string, state: WatchState): void {
    this.storage.set(this.prefix + did, JSON.stringify(state));
  }

  /** Record a commit this device made. Call it after every repo write (write() does it for you). */
  recordOwnCommit(did: string, commit: OwnCommit): void {
    const state = this.load(did) ?? { v: 1, baselined: false, expected: {}, verified: null, own: [] };
    for (const w of commit.writes) {
      const path = `${w.collection}/${w.rkey}`;
      if (w.action === 'delete') { delete state.expected[path]; continue; }
      if (!w.cid) throw new Error(`recordOwnCommit: the ${w.action} of ${path} needs the record CID`);
      state.expected[path] = w.cid;
    }
    if (commit.cid) {
      state.own.push(commit.cid);
      if (state.own.length > MAX_OWN) state.own.splice(0, state.own.length - MAX_OWN);
    }
    this.save(did, state);
  }

  /**
   * Record the result of a repo write made with any client: pass the method,
   * its input and its output. Understands createRecord, putRecord,
   * deleteRecord and applyWrites; other methods are ignored.
   */
  recordWriteResult(nsid: string, input: Record<string, unknown>, output: unknown): void {
    if (!WRITE_NSIDS.has(nsid)) return;
    const out = (output ?? {}) as { uri?: string; cid?: string; commit?: { cid?: string; rev?: string }; results?: Array<{ uri?: string; cid?: string }> };
    const repo = typeof input.repo === 'string' ? input.repo : '';
    const commit = { cid: out.commit?.cid, rev: out.commit?.rev };
    const didOf = (uri?: string) => parseAtUri(uri)?.did ?? repo;

    if (nsid === 'com.atproto.repo.deleteRecord') {
      if (!repo.startsWith('did:')) throw new Error('recordWriteResult: deleteRecord needs repo as a DID');
      this.recordOwnCommit(repo, { ...commit, writes: [{ action: 'delete', collection: String(input.collection), rkey: String(input.rkey) }] });
      return;
    }
    if (nsid === 'com.atproto.repo.applyWrites') {
      const writes = Array.isArray(input.writes) ? input.writes as Array<{ $type?: string; collection: string; rkey?: string }> : [];
      const results = Array.isArray(out.results) ? out.results : [];
      let did = repo;
      const own: OwnWrite[] = writes.map((w, i) => {
        const result = results[i] ?? {};
        const at = parseAtUri(result.uri);
        if (at) did = at.did;
        const rkey = at?.rkey ?? w.rkey;
        if (!rkey) throw new Error('recordWriteResult: applyWrites output lacks a uri for a write without rkey');
        const action = w.$type?.endsWith('#delete') ? 'delete' : w.$type?.endsWith('#update') ? 'update' : 'create';
        return { action, collection: w.collection, rkey, cid: action === 'delete' ? undefined : result.cid };
      });
      if (!did.startsWith('did:')) throw new Error('recordWriteResult: cannot tell the repository DID');
      this.recordOwnCommit(did, { ...commit, writes: own });
      return;
    }
    const at = parseAtUri(out.uri);
    const did = didOf(out.uri);
    if (!did.startsWith('did:')) throw new Error('recordWriteResult: cannot tell the repository DID');
    const rkey = at?.rkey ?? (typeof input.rkey === 'string' ? input.rkey : '');
    this.recordOwnCommit(did, {
      ...commit,
      writes: [{ action: nsid === 'com.atproto.repo.createRecord' ? 'create' : 'update', collection: String(input.collection), rkey, cid: out.cid }],
    });
  }

  /** Make a repo write through `client` (e.g. the SDK's OpenFederationClient) and record it as this device's own. */
  async write(client: XrpcWriter, nsid: string, input: Record<string, unknown>): Promise<unknown> {
    const output = await client.fetch(nsid, { method: 'POST', body: input });
    this.recordWriteResult(nsid, input, output);
    return output;
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json() as Promise<T>;
  }

  /**
   * Compare the account's public repository with what this device expects.
   * The first check records a baseline. Unexplained changes are reported on
   * every check until acknowledge() accepts them.
   */
  async check(did: string, opts: { source?: string } = {}): Promise<RepoCheckResult> {
    const source = (opts.source ?? this.source).replace(/\/+$/, '');
    const q = `did=${encodeURIComponent(did)}`;
    const head = await this.getJson<{ cid?: string; rev?: string }>(`${source}/xrpc/com.atproto.sync.getLatestCommit?${q}`);
    if (typeof head.cid !== 'string' || typeof head.rev !== 'string') throw new Error('getLatestCommit returned no commit');
    const state = this.load(did);
    const latestRef = (ref: CommitRef, st: WatchState | null) => ({ ...ref, time: revToTime(ref.rev), own: !!st?.own.includes(ref.cid) });

    if (state?.baselined && state.verified?.cid === head.cid) {
      return { did, source, status: 'clean', latest: latestRef({ rev: head.rev, cid: head.cid }, state), unknownCommits: [] };
    }

    const res = await this.fetchFn(`${source}/xrpc/com.atproto.sync.getRepo?${q}`);
    if (!res.ok) throw new Error(`getRepo answered ${res.status}`);
    const car = new Uint8Array(await res.arrayBuffer());
    const { commit, records } = readRepoCar(car);
    if (commit.did !== did) throw new Error(`The repository served is for ${commit.did}, not ${did}`);
    const ref = { rev: commit.rev, cid: commit.cid };

    if (!state?.baselined) {
      const own = state?.own ?? [];
      this.save(did, { v: 1, baselined: true, expected: Object.fromEntries(records), verified: ref, own });
      return { did, source, status: 'baseline', latest: latestRef(ref, state), unknownCommits: [], car };
    }

    const changes: RepoChange[] = [];
    const watched = (path: string) => !this.collections || this.collections.has(splitPath(path).collection);
    for (const [path, cid] of records) {
      if (!watched(path)) continue;
      const expectedCid = state.expected[path] ?? null;
      if (expectedCid === cid) continue;
      changes.push({ path, ...splitPath(path), action: expectedCid ? 'update' : 'create', cid, expectedCid });
    }
    for (const [path, expectedCid] of Object.entries(state.expected)) {
      if (!watched(path) || records.has(path)) continue;
      changes.push({ path, ...splitPath(path), action: 'delete', cid: null, expectedCid });
    }
    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    if (changes.length === 0) {
      // Records outside the watched collections are taken as they are.
      this.save(did, { ...state, expected: Object.fromEntries(records), verified: ref });
      return { did, source, status: 'clean', latest: latestRef(ref, state), unknownCommits: [], car };
    }
    return {
      did, source, status: 'unknown-changes', latest: latestRef(ref, state), car,
      unknownCommits: [{ ...ref, time: revToTime(ref.rev), since: state.verified, changes, commit }],
    };
  }

  /**
   * Accept the changes a check reported (for example, they came from the
   * person's other device). They are expected from now on.
   */
  acknowledge(did: string, result: RepoCheckResult): void {
    const state = this.load(did);
    if (!state || result.did !== did) return;
    for (const u of result.unknownCommits) {
      for (const c of u.changes) {
        if (c.cid) state.expected[c.path] = c.cid;
        else delete state.expected[c.path];
      }
      state.verified = { rev: u.rev, cid: u.cid };
    }
    this.save(did, state);
  }

  /** Drop everything kept for this DID; the next check records a new baseline. */
  forget(did: string): void {
    this.storage.remove(this.prefix + did);
  }
}
