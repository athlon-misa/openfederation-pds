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
 * (`setDeviceRepoKey`, `rotateDeviceRepoKey`), or naming the server's key
 * again (`disableDeviceSigning`). Keep the key on the device with
 * `rememberDeviceKeyWithPasskey`. In `assisted`, a switch back by the
 * server's backup key is public in PLC (`findDeviceSigningSwitchBack`) and the
 * phrase cancels it for 72 hours (`cancelDeviceSigningSwitchBack`).
 */
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base32Lower, base64UrlDecode, didKeyFor } from './encoding.js';
import { buildCancelOp, cidForPlcOp, plcOperationSigner, signPlcOperation, type PlcOperation, type SignedPlcOperation } from './plc.js';
import { readCar, readRepoCar, listMstRecords, verifyRepoCommit } from './repo-watch.js';

/** How long a higher rotation key can cancel an update signed by a lower one (PLC's rule). */
const CANCEL_WINDOW_MS = 72 * 60 * 60 * 1000;

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
 * Who signs a change of the DID's `atproto` key:
 *  - `rotationPrivateKey`: the phrase's rotation key, which must be the DID's
 *    first rotation key; nothing can cancel the update.
 *  - `recoveryPrivateKey`: the recovery key (#238, `deriveRecoveryKey`),
 *    listed below the phrase key. PLC accepts the update, but the phrase can
 *    cancel it for 72 hours (`cancelUntil`), as any update by a lower key.
 */
export type AtprotoKeySigner =
  | { rotationPrivateKey: Uint8Array; recoveryPrivateKey?: undefined }
  | { recoveryPrivateKey: Uint8Array; rotationPrivateKey?: undefined };

export interface AtprotoKeyChange {
  previous: SignedPlcOperation;
  operation: SignedPlcOperation;
  /** Set when a lower key (the recovery key) signed: until then the phrase can cancel it. */
  cancelUntil?: Date;
}

function signerOf(s: AtprotoKeySigner): Uint8Array {
  const key = s.rotationPrivateKey ?? s.recoveryPrivateKey;
  if (!key) throw new Error('Pass rotationPrivateKey (the phrase) or recoveryPrivateKey (the recovery key)');
  return key;
}

/**
 * Sign and submit the PLC update naming `atprotoDidKey`, then check PLC shows
 * it. With `rotationPrivateKey` the key must be the DID's first rotation key,
 * so the update cannot be cancelled by a lower one; with `recoveryPrivateKey`
 * it must be one of the DID's other rotation keys, and the result says until
 * when the phrase can cancel it.
 */
export async function setAtprotoKey(p: PlcIo & AtprotoKeySigner & { atprotoDidKey: string }): Promise<AtprotoKeyChange> {
  const previous = await latestOp(p);
  const signingKey = signerOf(p);
  const mine = didKeyFor('secp256k1', secp256k1.getPublicKey(signingKey, true));
  const rank = previous.rotationKeys.indexOf(mine);
  if (p.rotationPrivateKey && rank !== 0) {
    throw new Error("This rotation key is not the DID's first rotation key; PLC would refuse the update or a higher key could cancel it");
  }
  if (p.recoveryPrivateKey && rank < 1) {
    throw new Error(rank === 0 ? 'This is the DID\'s first rotation key: pass it as rotationPrivateKey' : 'This recovery key is not a rotation key of the DID');
  }
  const operation = signPlcOperation(buildAtprotoKeyOp(previous, p.atprotoDidKey), signingKey);
  const plc = p.plcUrl.replace(/\/+$/, '');
  const doFetch = doFetchOf(p);
  // Taken before PLC stamps the operation, so the deadline is never later than PLC's.
  const submittedAt = Date.now();
  const submitted = await doFetch(`${plc}/${p.did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
  });
  if (!submitted.ok) throw new Error(`PLC refused the operation (${submitted.status}): ${await submitted.text()}`);
  const data = await (await doFetch(`${plc}/${p.did}/data`)).json() as { verificationMethods?: Record<string, string> };
  if (data.verificationMethods?.atproto !== p.atprotoDidKey) throw new Error('PLC does not show the new atproto key');
  return { previous, operation, ...(rank > 0 ? { cancelUntil: new Date(submittedAt + CANCEL_WINDOW_MS) } : {}) };
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
}): Promise<AtprotoKeyChange> {
  const change = await setAtprotoKey({ plcUrl: p.plcUrl, did: p.did, fetch: p.fetch, rotationPrivateKey: p.rotationPrivateKey, atprotoDidKey: p.deviceDidKey });
  if (p.client) await p.client.fetch('net.openfederation.account.enableDeviceSigning', { method: 'POST', body: {} });
  return change;
}

/**
 * Turn device signing off: the PLC update naming the server's repo key again
 * (`serverDidKey`, or com.atproto.identity.getRecommendedDidCredentials from
 * `client`), then net.openfederation.account.disableDeviceSigning. Signed with
 * the phrase, or with the recovery key when the phrase is lost too (the phrase
 * can then cancel it for 72 hours, and the PDS turns device signing off only
 * once PLC names its key).
 */
export async function disableDeviceSigning(p: PlcIo & AtprotoKeySigner & {
  serverDidKey?: string;
  client?: XrpcCaller;
}): Promise<AtprotoKeyChange> {
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
 * Point the DID at a new device key: a new or replacement device, or a lost
 * one. Signed with the phrase (`rotationPrivateKey`), or with the recovery key
 * (`recoveryPrivateKey`, #238) when the phrase is not at hand; the phrase can
 * cancel a recovery-key change for 72 hours (`cancelUntil`). The old device's
 * key stops verifying new commits at once; records already written stay.
 *
 * With `client`, the PDS is told (net.openfederation.account.enableDeviceSigning
 * again), so it records the new key, and turns device signing on if it was off.
 */
export async function setDeviceRepoKey(p: PlcIo & AtprotoKeySigner & { deviceDidKey: string; client?: XrpcCaller }): Promise<AtprotoKeyChange> {
  const change = await setAtprotoKey({ ...p, atprotoDidKey: p.deviceDidKey });
  if (p.client) await p.client.fetch('net.openfederation.account.enableDeviceSigning', { method: 'POST', body: {} });
  return change;
}

/**
 * Rotate the device key: make a new one here and point the DID at it
 * (`setDeviceRepoKey`). Keep `key.privateKey` before anything else
 * (`rememberDeviceKeyWithPasskey`); the previous key no longer signs.
 */
export async function rotateDeviceRepoKey(p: PlcIo & AtprotoKeySigner & { client?: XrpcCaller }): Promise<AtprotoKeyChange & { key: DeviceRepoKey }> {
  const key = generateDeviceRepoKey();
  const change = await setDeviceRepoKey({ ...p, deviceDidKey: key.didKey });
  return { ...change, key };
}

// ── A switch back by a lower key, and cancelling it ──────────────

/** A change of the DID's `atproto` key signed by a key below the first (the server's backup in `assisted`, or a recovery key). */
export interface AtprotoKeySwitch {
  /** CID of the operation that made the change. */
  cid: string;
  createdAt: string;
  /** The state before it: cancelling restores this (`buildCancelOp(before)`). */
  before: SignedPlcOperation;
  operation: SignedPlcOperation;
  /** The `atproto` key before and after. */
  from: string | undefined;
  to: string | undefined;
  /** The did:key that signed it, and its place among the rotation keys before (≥ 1). */
  signedBy: string;
  signerRank: number;
  /** End of the 72 hours in which a higher key can cancel it. */
  cancelUntil: Date;
  cancellable: boolean;
}

interface PlcAuditEntry { cid: string; createdAt: string; nullified: boolean; operation: SignedPlcOperation }

/**
 * The latest change of the DID's `atproto` key, if a key other than the
 * first rotation key signed it: in `assisted`, the server switching device
 * signing back with its backup key (or a recovery key pointing the DID at a
 * new device). Read from PLC's audit log, not from the PDS, so a server
 * cannot hide it. Null when the latest `atproto` change (if any) was signed
 * by the first key.
 *
 * Changes after it are cancelled along with it (`cancelDeviceSigningSwitchBack`).
 */
export async function findDeviceSigningSwitchBack(p: PlcIo & { now?: number }): Promise<AtprotoKeySwitch | null> {
  const res = await doFetchOf(p)(`${p.plcUrl.replace(/\/+$/, '')}/${p.did}/log/audit`);
  if (!res.ok) throw new Error(`PLC audit log lookup failed (${res.status})`);
  const live = (await res.json() as PlcAuditEntry[]).filter((e) => !e.nullified);
  const now = p.now ?? Date.now();
  for (let i = live.length - 1; i >= 1; i--) {
    const before = live[i - 1].operation;
    const op = live[i].operation;
    if (before.verificationMethods?.atproto === op.verificationMethods?.atproto) continue;
    const signedBy = plcOperationSigner(op, before.rotationKeys);
    const signerRank = signedBy ? before.rotationKeys.indexOf(signedBy) : -1;
    if (!signedBy || signerRank < 1) return null;
    const cancelUntil = new Date(new Date(live[i].createdAt).getTime() + CANCEL_WINDOW_MS);
    return {
      cid: live[i].cid, createdAt: live[i].createdAt, before, operation: op,
      from: before.verificationMethods?.atproto, to: op.verificationMethods?.atproto,
      signedBy, signerRank, cancelUntil, cancellable: now < cancelUntil.getTime(),
    };
  }
  return null;
}

/**
 * Cancel a switch back of the DID's `atproto` key by a lower key (in
 * `assisted`, the server's backup key) within its 72 hours, with the phrase
 * that was first before it, then tell the PDS (enableDeviceSigning, when a
 * `client` is given) so device signing is on again. Everything after the
 * switch is cancelled with it, as with any PLC cancellation.
 *
 * Records the server wrote while its key was in charge were signed by it and
 * do not verify against the device key; check the repository before signing
 * on top of them (`deviceApplyWrites` with `trustedHeadKeys`, RepoWatcher).
 */
export async function cancelDeviceSigningSwitchBack(p: PlcIo & { rotationPrivateKey: Uint8Array; client?: XrpcCaller }): Promise<{ cancelled: AtprotoKeySwitch; operation: SignedPlcOperation; atprotoKey: string | undefined }> {
  const found = await findDeviceSigningSwitchBack(p);
  if (!found) throw new Error('No change of the signing key by a lower key to cancel');
  if (!found.cancellable) throw new Error(`The 72 hours to cancel it ended at ${found.cancelUntil.toISOString()}`);
  const mine = didKeyFor('secp256k1', secp256k1.getPublicKey(p.rotationPrivateKey, true));
  const rank = found.before.rotationKeys.indexOf(mine);
  if (rank < 0 || rank >= found.signerRank) throw new Error('This key does not rank above the one that made the change, so it cannot cancel it');
  const operation = signPlcOperation(buildCancelOp(found.before), p.rotationPrivateKey);
  const plc = p.plcUrl.replace(/\/+$/, '');
  const doFetch = doFetchOf(p);
  const submitted = await doFetch(`${plc}/${p.did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
  });
  if (!submitted.ok) throw new Error(`PLC refused the cancellation (${submitted.status}): ${await submitted.text()}`);
  const data = await (await doFetch(`${plc}/${p.did}/data`)).json() as { verificationMethods?: Record<string, string> };
  if (data.verificationMethods?.atproto !== found.from) throw new Error('PLC does not show the cancellation');
  if (p.client) await p.client.fetch('net.openfederation.account.enableDeviceSigning', { method: 'POST', body: {} });
  return { cancelled: found, operation, atprotoKey: found.from };
}

// ── What the PDS says ────────────────────────────────────────────

/** A feature that writes into the person's repository, and whether it works while device signing is on. */
export interface DeviceSigningFeature {
  id: string;
  title: string;
  /** True: it works with device signing on (signed on the device). False: unavailable while it is on. */
  available: boolean;
}

/** net.openfederation.account.getDeviceSigning */
export interface DeviceSigningStatus {
  /** The installation offers device signing (DEVICE_SIGNING_ALLOWED). */
  allowed: boolean;
  custodyMode: 'custodial' | 'assisted' | 'self' | null;
  /** Allowed here and the custody mode can have it (self or assisted). */
  eligible: boolean;
  /** On at the PDS: every server-side write into the repo refuses. */
  deviceSigning: boolean;
  since: string | null;
  /** The key the PDS recorded when it was last turned on. */
  recordedKey: string | null;
  /** The DID's atproto key in PLC now (null when PLC could not be read: `plcReadable`). */
  atprotoKey: string | null;
  plcReadable: boolean;
  /** This server's repo key for the account (what PLC names when device signing is off). */
  serverKey: string | null;
  /**
   * `off`; `on`; `resumable` (off at the PDS but PLC names a key that is not
   * the server's, for example after cancelling a switch back: enableDeviceSigning
   * turns it on again); `switchedBack` (on at the PDS but PLC names the
   * server's key again).
   */
  state: 'off' | 'on' | 'resumable' | 'switchedBack';
  features: DeviceSigningFeature[];
}

/** Ask the PDS (net.openfederation.account.getDeviceSigning). Check `atprotoKey` against PLC yourself when it matters. */
export async function getDeviceSigningStatus(client: XrpcCaller): Promise<DeviceSigningStatus> {
  return await client.fetch('net.openfederation.account.getDeviceSigning', { method: 'GET' }) as DeviceSigningStatus;
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
  /** `UntrustedHead` when the repository's current head was not signed by a key in `trustedHeadKeys`. */
  readonly reason?: 'UntrustedHead';
  constructor(message: string, reason?: 'UntrustedHead') { super(message); this.name = 'DeviceCommitRejected'; this.reason = reason; }
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
 *
 * `trustedHeadKeys` (did:keys: this device's, and earlier device keys of the
 * person) also requires the current head commit to be signed by one of them.
 * Without it the device signs on top of whatever the repository holds, which
 * is right for the first device write after turning device signing on (the
 * head is the server's). After that, pass it: if the server's key was in
 * charge for a while (an `assisted` switch back, later cancelled), records it
 * wrote then are in the tree, and signing on top of them would make them the
 * person's. Rejected with `reason: 'UntrustedHead'`; review the repository
 * (RepoWatcher) and delete what is not yours first.
 */
export function verifyPreparedCommit(p: { did: string; prepared: PreparedCommit; writes: DeviceWrite[]; previousCar: Uint8Array; trustedHeadKeys?: string[] }): void {
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
  if (p.trustedHeadKeys && !p.trustedHeadKeys.some((k) => verifyRepoCommit(prevCommit, k))) {
    throw new DeviceCommitRejected('The repository\'s current head was not signed by your device: someone else (this server, while its key was in charge) wrote to it since. Review the repository before signing on top of it', 'UntrustedHead');
  }

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
 * `trustedHeadKeys`: see verifyPreparedCommit.
 */
export async function deviceApplyWrites(p: {
  client: XrpcCaller;
  did: string;
  deviceKey: Uint8Array;
  writes: DeviceWrite[];
  verifyAgainst?: string;
  skipTreeCheck?: boolean;
  trustedHeadKeys?: string[];
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
      verifyPreparedCommit({ did: p.did, prepared, writes, previousCar: new Uint8Array(await res.arrayBuffer()), trustedHeadKeys: p.trustedHeadKeys });
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
