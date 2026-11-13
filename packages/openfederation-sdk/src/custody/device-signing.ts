/**
 * Device signing (#240, ADR-003 decision 14): the person's device holds the
 * repository signing key, and the DID's `atproto` verification method names
 * it. Every relay and app checks commits against that key, so from then on a
 * commit the server signs is rejected everywhere: the server cannot write
 * posts as the person. Only `self` and `assisted` accounts can do this (it
 * takes a PLC update signed with the person's rotation key).
 *
 *   const device = generateDeviceRepoKey();            // keep device.privateKey on the device
 *   await enableDeviceSigning({ plcUrl, did, rotationPrivateKey, deviceDidKey: device.didKey, client });
 *   await deviceCreateRecord({ client, did, deviceKey: device.privateKey, verifyAgainst: pdsUrl,
 *     collection: 'app.bsky.feed.post', record: { text: 'hi', createdAt } });
 *
 * Each write is prepared by the server (net.openfederation.repo.prepareCommit),
 * checked and signed here, and submitted (submitCommit). The check is what
 * makes the signature mean something: the device signs a tree root, so before
 * signing it compares the whole new tree with the previous one and refuses
 * unless the only differences are its own writes. A server that slips in an
 * extra record gets no signature.
 *
 * What the person gives up: nothing can be written to their repository while
 * the device is offline. Losing the device loses nothing permanent: the
 * phrase (or a recovery key) signs a PLC update naming a new device key
 * (`setDeviceRepoKey`), or naming the server's key again (`disableDeviceSigning`).
 */
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base32Lower, base64UrlDecode, didKeyFor } from './encoding.js';
import { cidForPlcOp, signPlcOperation, type PlcOperation, type SignedPlcOperation } from './plc.js';
import { readCar, readRepoCar, listMstRecords } from './repo-watch.js';

// ── Keys ─────────────────────────────────────────────────────────

export interface DeviceRepoKey {
  /** secp256k1 private key (32 bytes). Where it is kept is the application's choice; it never leaves the device. */
  privateKey: Uint8Array;
  /** did:key of the public key, for the DID's `atproto` verification method. */
  didKey: string;
}

/** A fresh secp256k1 repo signing key, made on the device. */
export function generateDeviceRepoKey(): DeviceRepoKey {
  return deviceRepoKeyFrom(secp256k1.utils.randomPrivateKey());
}

/** The did:key for a stored device key. */
export function deviceRepoKeyFrom(privateKey: Uint8Array): DeviceRepoKey {
  return { privateKey, didKey: didKeyFor('secp256k1', secp256k1.getPublicKey(privateKey, true)) };
}

/**
 * Sign the bytes prepareCommit returned (the commit's DAG-CBOR without
 * `sig`) as AT Protocol does: ECDSA over SHA-256, compact 64 bytes, low-S.
 */
export function signCommitBytes(unsigned: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return secp256k1.sign(sha256(unsigned), privateKey, { lowS: true }).toCompactRawBytes();
}

// ── PLC: pointing the DID's atproto key at the device, and back ──

/** The PLC update that names `atprotoDidKey` as the DID's repo key; everything else as before. */
export function buildAtprotoKeyOp(previous: SignedPlcOperation, atprotoDidKey: string): PlcOperation {
  return {
    type: 'plc_operation',
    prev: cidForPlcOp(previous),
    rotationKeys: [...previous.rotationKeys],
    verificationMethods: { ...previous.verificationMethods, atproto: atprotoDidKey },
    alsoKnownAs: [...previous.alsoKnownAs],
    services: { atproto_pds: { ...previous.services.atproto_pds } },
  };
}

type Fetch = typeof globalThis.fetch;

/** Anything with the SDK client's `fetch(nsid, opts)` (OpenFederationClient). */
export interface XrpcCaller {
  fetch(nsid: string, opts: { method: 'GET' | 'POST'; body?: Record<string, unknown>; params?: Record<string, string> }): Promise<unknown>;
}

interface PlcIo { plcUrl: string; did: string; fetch?: Fetch }

function doFetchOf(p: { fetch?: Fetch }): Fetch {
  return p.fetch ?? ((...args: Parameters<Fetch>) => globalThis.fetch(...args));
}

async function latestOp(p: PlcIo): Promise<SignedPlcOperation> {
  const res = await doFetchOf(p)(`${p.plcUrl.replace(/\/+$/, '')}/${p.did}/log`);
  if (!res.ok) throw new Error(`PLC log lookup failed (${res.status})`);
  const log = await res.json() as Array<SignedPlcOperation | { type: string }>;
  const last = log[log.length - 1] as SignedPlcOperation | undefined;
  if (!last || last.type !== 'plc_operation') throw new Error('The DID has no current PLC operation (deleted, or a legacy format)');
  return last;
}

/**
 * Sign (with the person's rotation key) and submit the PLC update naming
 * `atprotoDidKey`, then check PLC shows it. The key must be the DID's first
 * rotation key, so the update cannot be cancelled by a lower one.
 */
export async function setAtprotoKey(p: PlcIo & { rotationPrivateKey: Uint8Array; atprotoDidKey: string }): Promise<{ previous: SignedPlcOperation; operation: SignedPlcOperation }> {
  const previous = await latestOp(p);
  const mine = didKeyFor('secp256k1', secp256k1.getPublicKey(p.rotationPrivateKey, true));
  if (previous.rotationKeys[0] !== mine) {
    throw new Error("This rotation key is not the DID's first rotation key; PLC would refuse the update or a higher key could cancel it");
  }
  const operation = signPlcOperation(buildAtprotoKeyOp(previous, p.atprotoDidKey), p.rotationPrivateKey);
  const plc = p.plcUrl.replace(/\/+$/, '');
  const doFetch = doFetchOf(p);
  const submitted = await doFetch(`${plc}/${p.did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
  });
  if (!submitted.ok) throw new Error(`PLC refused the operation (${submitted.status}): ${await submitted.text()}`);
  const data = await (await doFetch(`${plc}/${p.did}/data`)).json() as { verificationMethods?: Record<string, string> };
  if (data.verificationMethods?.atproto !== p.atprotoDidKey) throw new Error('PLC does not show the new atproto key');
  return { previous, operation };
}

/**
 * Turn device signing on: the PLC update naming the device key (signed with
 * the phrase's rotation key, `deriveCustodyKeys(phrase).rotationPrivateKey`),
 * then net.openfederation.account.enableDeviceSigning on the PDS when a
 * `client` is given. From the PLC update on, server-signed commits no longer
 * verify, so do both in one go.
 */
export async function enableDeviceSigning(p: PlcIo & {
  rotationPrivateKey: Uint8Array;
  deviceDidKey: string;
  client?: XrpcCaller;
}): Promise<{ previous: SignedPlcOperation; operation: SignedPlcOperation }> {
  const change = await setAtprotoKey({ ...p, atprotoDidKey: p.deviceDidKey });
  if (p.client) await p.client.fetch('net.openfederation.account.enableDeviceSigning', { method: 'POST', body: {} });
  return change;
}

/**
 * Turn device signing off: the PLC update naming the server's repo key again
 * (`serverDidKey`, or com.atproto.identity.getRecommendedDidCredentials from
 * `client`), then net.openfederation.account.disableDeviceSigning.
 */
export async function disableDeviceSigning(p: PlcIo & {
  rotationPrivateKey: Uint8Array;
  serverDidKey?: string;
  client?: XrpcCaller;
}): Promise<{ previous: SignedPlcOperation; operation: SignedPlcOperation }> {
  let serverDidKey = p.serverDidKey;
  if (!serverDidKey) {
    if (!p.client) throw new Error('Pass serverDidKey or a client to ask the PDS for it');
    const creds = await p.client.fetch('com.atproto.identity.getRecommendedDidCredentials', { method: 'GET' }) as { verificationMethods?: { atproto?: string } };
    serverDidKey = creds.verificationMethods?.atproto;
    if (!serverDidKey) throw new Error('The PDS did not name its repo key');
  }
  const change = await setAtprotoKey({ ...p, atprotoDidKey: serverDidKey });
  if (p.client) await p.client.fetch('net.openfederation.account.disableDeviceSigning', { method: 'POST', body: {} });
  return change;
}

/**
 * Point the DID at a new device key (a new or replacement device), signed
 * with the phrase's rotation key. Device signing stays on; the old device's
 * key stops verifying new commits at once.
 */
export async function setDeviceRepoKey(p: PlcIo & { rotationPrivateKey: Uint8Array; deviceDidKey: string }): Promise<{ previous: SignedPlcOperation; operation: SignedPlcOperation }> {
  return setAtprotoKey({ ...p, atprotoDidKey: p.deviceDidKey });
}

// ── Checking a prepared commit before signing it ─────────────────

export type DeviceWrite =
  | { action: 'create'; collection: string; rkey?: string; record: Record<string, unknown> }
  | { action: 'update'; collection: string; rkey: string; record: Record<string, unknown> }
  | { action: 'delete'; collection: string; rkey: string };

export interface PreparedCommit {
  handle: string;
  did: string;
  rev: string;
  prevRoot: string;
  /** Base64. */
  unsignedCommit: string;
  newBlocks: Array<{ cid: string; bytes: string }>;
  writes: Array<{ collection: string; rkey: string; uri: string; cid?: string }>;
  expiresAt: string;
}

export class DeviceCommitRejected extends Error {
  constructor(message: string) { super(message); this.name = 'DeviceCommitRejected'; }
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

/** A CID object as dag-cbor makes them, from its `b…` string (CBOR tag 42). */
function cidFromString(cid: string): unknown {
  if (!cid.startsWith('b')) throw new Error('Only base32 CIDs are supported');
  const bytes = base32Decode(cid.slice(1));
  const len = bytes.length + 1;
  const header = len < 24 ? [0x40 + len] : len < 256 ? [0x58, len] : [0x59, len >> 8, len & 0xff];
  const encoded = new Uint8Array([0xd8, 0x2a, ...header, 0x00, ...bytes]);
  return dagCbor.decode(encoded);
}

/** AT Protocol's JSON record form to the data model: `{$link}` → CID, `{$bytes}` → bytes. */
function lexToIpld(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lexToIpld);
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj.$link === 'string') return cidFromString(obj.$link);
    if (keys.length === 1 && typeof obj.$bytes === 'string') return base64Decode(obj.$bytes);
    const out: Record<string, unknown> = {};
    for (const k of keys) if (obj[k] !== undefined) out[k] = lexToIpld(obj[k]);
    return out;
  }
  return value;
}

/**
 * The CID a record gets in a repository (dag-cbor, sha-256, CIDv1, base32),
 * with `{$link}` and `{$bytes}` (blob refs) in their data-model form.
 */
export function repoRecordCid(record: Record<string, unknown>): string {
  const hash = sha256(dagCbor.encode(lexToIpld(record)));
  const bytes = new Uint8Array(4 + hash.length);
  bytes.set([0x01, 0x71, 0x12, 0x20]); bytes.set(hash, 4);
  return `b${base32Lower(bytes)}`;
}

/**
 * Check a prepared commit before signing it: the unsigned commit is a plain
 * v3 commit for `did`, follows the repository state in `previousCar`
 * (com.atproto.sync.getRepo), has a later revision, and the new tree holds
 * exactly the previous records with `writes` applied (record CIDs computed
 * here). Throws DeviceCommitRejected otherwise.
 *
 * `previousCar` is the server's account of the current state. It may itself
 * be checked independently (a relay's copy, RepoWatcher); this function
 * makes sure the device signs nothing on top of it but its own writes.
 */
export function verifyPreparedCommit(p: { did: string; prepared: PreparedCommit; writes: DeviceWrite[]; previousCar: Uint8Array }): void {
  const reject = (m: string): never => { throw new DeviceCommitRejected(m); };
  const { prepared } = p;
  const unsignedBytes = base64Decode(prepared.unsignedCommit);
  const unsigned = dagCbor.decode(unsignedBytes) as Record<string, unknown>;
  const keys = Object.keys(unsigned).sort().join(',');
  if (keys !== 'data,did,prev,rev,version') reject(`Unexpected commit fields: ${keys}`);
  if (unsigned.did !== p.did || prepared.did !== p.did) reject('The commit is for another DID');
  if (unsigned.version !== 3) reject('Not a version 3 commit');
  if (unsigned.prev !== null) reject('A v3 commit has prev = null');
  if (typeof unsigned.rev !== 'string' || unsigned.rev !== prepared.rev) reject('The revision does not match');
  const data = (unsigned.data as { toString(): string } | null)?.toString();
  if (!data) reject('The commit names no tree');

  const previous = readCar(p.previousCar);
  if (previous.roots[0] !== prepared.prevRoot) reject('The commit does not follow the repository state given');
  const { commit: prevCommit, records: before } = readRepoCar(p.previousCar);
  if (prevCommit.did !== p.did) reject('The previous state is another DID\'s');
  if (!((unsigned.rev as string) > prevCommit.rev)) reject('The revision does not advance');

  const expected = new Map(before);
  if (p.writes.length !== prepared.writes.length) reject('The server prepared a different number of writes');
  p.writes.forEach((w, i) => {
    const echoed = prepared.writes[i];
    if (echoed.collection !== w.collection || (w.rkey !== undefined && echoed.rkey !== w.rkey)) reject(`Write ${i} was prepared for another record`);
    const path = `${w.collection}/${echoed.rkey}`;
    if (w.action === 'delete') {
      if (!expected.delete(path)) reject(`Write ${i} deletes a record that is not there`);
      return;
    }
    // create and update both write the record (as com.atproto.repo.putRecord does).
    expected.set(path, repoRecordCid(w.record));
  });

  const blocks = new Map(previous.blocks);
  for (const b of prepared.newBlocks) {
    const bytes = base64Decode(b.bytes);
    const cidBytes = base32Decode(b.cid.slice(1));
    // CIDv1, dag-cbor or raw, sha-256: the last 32 bytes are the digest.
    const ok = b.cid.startsWith('b') && cidBytes[0] === 0x01 && cidBytes[2] === 0x12 && cidBytes[3] === 0x20
      && cidBytes.length === 36 && sha256(bytes).every((x, j) => x === cidBytes[4 + j]);
    if (!ok) reject(`Block ${b.cid} does not match its CID`);
    blocks.set(b.cid, bytes);
  }

  let after: Map<string, string>;
  try {
    after = listMstRecords(blocks, data!, true);
  } catch (err) {
    return reject(`The new tree cannot be read: ${(err as Error).message}`);
  }
  if (after.size !== expected.size) reject(`The new tree has ${after.size} records, expected ${expected.size}`);
  for (const [path, cid] of expected) {
    if (after.get(path) !== cid) reject(`The new tree differs at ${path}`);
  }
}

// ── Prepare → check → sign → submit ──────────────────────────────

export interface DeviceWriteResult {
  commit: { cid: string; rev: string };
  writes: Array<{ collection: string; rkey: string; uri: string; cid?: string }>;
}

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; error?: unknown } | null;
  return typeof e?.code === 'string' ? e.code : typeof e?.error === 'string' ? e.error : undefined;
}

/**
 * Write to the repository with the device key: prepare on the PDS, check the
 * new tree (see verifyPreparedCommit), sign, submit. Retries when another
 * write landed in between (RepoHeadMoved), up to `attempts` times.
 *
 * `verifyAgainst` is a base URL serving com.atproto.sync.getRepo for the
 * account (its PDS, or a relay); the current repository is fetched from it
 * for the check. Pass `skipTreeCheck: true` only to sign whatever the server
 * prepared (then the server could add records to the commit).
 */
export async function deviceApplyWrites(p: {
  client: XrpcCaller;
  did: string;
  deviceKey: Uint8Array;
  writes: DeviceWrite[];
  verifyAgainst?: string;
  skipTreeCheck?: boolean;
  attempts?: number;
  fetch?: Fetch;
}): Promise<DeviceWriteResult> {
  if (!p.verifyAgainst && !p.skipTreeCheck) throw new Error('Pass verifyAgainst (a URL serving com.atproto.sync.getRepo) or skipTreeCheck: true');
  // Creates get their rkey here, so the check knows every path in advance.
  const writes = p.writes.map((w) => (w.action === 'create' && !w.rkey ? { ...w, rkey: nextTid() } : w));
  const attempts = Math.max(1, p.attempts ?? 3);
  for (let attempt = 1; ; attempt++) {
    const prepared = await p.client.fetch('net.openfederation.repo.prepareCommit', {
      method: 'POST',
      body: { repo: p.did, writes: writes.map((w) => ({ action: w.action, collection: w.collection, rkey: w.rkey, ...('record' in w ? { value: w.record } : {}) })) },
    }) as PreparedCommit;
    if (!p.skipTreeCheck) {
      const res = await doFetchOf(p)(`${p.verifyAgainst!.replace(/\/+$/, '')}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(p.did)}`);
      if (!res.ok) throw new Error(`Could not read the repository to check the commit (${res.status})`);
      verifyPreparedCommit({ did: p.did, prepared, writes, previousCar: new Uint8Array(await res.arrayBuffer()) });
    }
    const sig = signCommitBytes(base64Decode(prepared.unsignedCommit), p.deviceKey);
    try {
      return await p.client.fetch('net.openfederation.repo.submitCommit', {
        method: 'POST', body: { handle: prepared.handle, sig: base64Encode(sig) },
      }) as DeviceWriteResult;
    } catch (err) {
      if (errorCode(err) !== 'RepoHeadMoved' || attempt >= attempts) throw err;
    }
  }
}

export async function deviceCreateRecord(p: Omit<Parameters<typeof deviceApplyWrites>[0], 'writes'> & { collection: string; rkey?: string; record: Record<string, unknown> }): Promise<DeviceWriteResult> {
  return deviceApplyWrites({ ...p, writes: [{ action: 'create', collection: p.collection, rkey: p.rkey, record: p.record }] });
}

/** Create or replace the record at `rkey`, as com.atproto.repo.putRecord. */
export async function devicePutRecord(p: Omit<Parameters<typeof deviceApplyWrites>[0], 'writes'> & { collection: string; rkey: string; record: Record<string, unknown> }): Promise<DeviceWriteResult> {
  return deviceApplyWrites({ ...p, writes: [{ action: 'update', collection: p.collection, rkey: p.rkey, record: p.record }] });
}

export async function deviceDeleteRecord(p: Omit<Parameters<typeof deviceApplyWrites>[0], 'writes'> & { collection: string; rkey: string }): Promise<DeviceWriteResult> {
  return deviceApplyWrites({ ...p, writes: [{ action: 'delete', collection: p.collection, rkey: p.rkey }] });
}

// A TID (AT Protocol record key): microseconds since 1970 and a clock id, base32-sortable.
const S32 = '234567abcdefghijklmnopqrstuvwxyz';
let lastTid = 0;
function nextTid(): string {
  let micros = Date.now() * 1000;
  if (micros <= lastTid) micros = lastTid + 1;
  lastTid = micros;
  const clockId = Math.floor(Math.random() * 1024);
  let v = (BigInt(micros) << 10n) | BigInt(clockId);
  let out = '';
  for (let i = 0; i < 13; i++) { out = S32[Number(v & 31n)] + out; v >>= 5n; }
  return out;
}
