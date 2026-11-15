/**
 * Device signing in the dashboard (#240, ADR-003 decision 14). This browser
 * makes the key that signs the person's repository, keeps it under a passkey
 * and puts it in the DID with a PLC update their 12 words (or their recovery
 * key) sign. The server is told afterwards and only ever sees did:keys.
 *
 * What the server says about the setting comes from
 * net.openfederation.account.getDeviceSigning; what PLC says (a switch back by
 * a lower key) is read from the public directory directly, so a server cannot
 * hide it.
 */
import {
  generateDeviceRepoKey, enableDeviceSigning, disableDeviceSigning, setDeviceRepoKey, buildAtprotoKeyOp,
  buildCancelOp, plcOperationSigner, signPlcOperation, submitPlcOperation, deriveRecoveryKey, deriveCustodyKeys,
  readRepoCar, verifyRepoCommit,
  type SignedPlcOperation, type XrpcCaller,
} from '@open-federation/sdk/custody';
import { call, plcDirectoryOf, MoveError } from '@/lib/move/xrpc';
import { assertPhraseBelongs, assertRecoveryPhraseBelongs, loadRemembered, type RecoveryMode } from '@/lib/custody/custody';
import { rememberDeviceKeyWithPasskey, type RememberedDeviceKey } from '@/lib/custody/device-key-store';

const CANCEL_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface DeviceSigningFeature { id: string; title: string; available: boolean }

/** net.openfederation.account.getDeviceSigning */
export interface DeviceSigningStatus {
  allowed: boolean;
  custodyMode: 'custodial' | 'assisted' | 'self' | null;
  eligible: boolean;
  deviceSigning: boolean;
  since: string | null;
  recordedKey: string | null;
  atprotoKey: string | null;
  plcReadable: boolean;
  serverKey: string | null;
  state: 'off' | 'on' | 'resumable' | 'switchedBack';
  features: DeviceSigningFeature[];
}

export async function deviceSigningStatus(pdsUrl: string, jwt: string): Promise<DeviceSigningStatus> {
  return call<DeviceSigningStatus>(pdsUrl, 'net.openfederation.account.getDeviceSigning', { jwt });
}

/** The SDK's client interface over this dashboard's plain XRPC calls. */
function clientFor(pdsUrl: string, jwt: string): XrpcCaller {
  return {
    fetch: (nsid, opts) => call(pdsUrl, nsid, {
      jwt,
      ...(opts.method === 'POST' ? { body: opts.body ?? {} } : {}),
      ...(opts.params ? { query: opts.params } : {}),
    }),
  };
}

// ── The key on this device ───────────────────────────────────────

const keyStore = (did: string) => `of.custody.deviceKey.${did}`;

export function loadDeviceKey(did: string): RememberedDeviceKey | null {
  try {
    const raw = localStorage.getItem(keyStore(did));
    const parsed = raw ? JSON.parse(raw) as RememberedDeviceKey : null;
    return parsed?.kind === 'device-repo-key' ? parsed : null;
  } catch { return null; }
}

function saveDeviceKey(did: string, stored: RememberedDeviceKey): void {
  try { localStorage.setItem(keyStore(did), JSON.stringify(stored)); } catch { throw new MoveError('This browser cannot store the key (storage is blocked or full). Nothing was changed.'); }
}

export function forgetDeviceKey(did: string): void {
  try { localStorage.removeItem(keyStore(did)); } catch { /* nothing to forget */ }
}

/**
 * A new key, sealed with a passkey and kept in this browser before anything
 * else changes: if the PLC update then fails, nothing names the key and
 * nothing is lost. Reuses the passkey that unlocks the 12 words, when there
 * is one (one prompt instead of two).
 */
async function newSealedKey(did: string, handle: string): Promise<string> {
  const key = generateDeviceRepoKey();
  const phrasePasskey = loadRemembered(did) as { credentialId?: string } | null;
  let stored: RememberedDeviceKey;
  try {
    stored = await rememberDeviceKeyWithPasskey({ privateKey: key.privateKey, rpName: 'OpenFederation', userName: handle, credentialId: phrasePasskey?.credentialId });
  } catch (err) {
    const name = err instanceof Error ? err.message : String(err);
    if (name === 'PasskeyCancelled' || (err as Error)?.name === 'NotAllowedError') throw new MoveError('The passkey prompt was cancelled or timed out. Nothing was changed.');
    throw new MoveError('This browser or device cannot keep the key safely: it needs a passkey that can lock data (the same kind that unlocks your 12 words). Nothing was changed.');
  } finally {
    key.privateKey.fill(0);
  }
  saveDeviceKey(did, stored);
  return stored.didKey;
}

// ── On, off, a new device ────────────────────────────────────────

/** Turn it on: a key made here, then your 12 words name it in your identity, then this server is told. */
export async function turnOnDeviceSigning(p: { pdsUrl: string; jwt: string; did: string; handle: string; phrase: string }): Promise<{ didKey: string }> {
  const keys = await assertPhraseBelongs(p.pdsUrl, p.did, p.phrase);
  const didKey = await newSealedKey(p.did, p.handle);
  await enableDeviceSigning({
    plcUrl: await plcDirectoryOf(p.pdsUrl), did: p.did, rotationPrivateKey: keys.rotationPrivateKey, deviceDidKey: didKey, client: clientFor(p.pdsUrl, p.jwt),
  });
  return { didKey };
}

/** Turn it off: your 12 words name this server's key again; the key on this device is forgotten. */
export async function turnOffDeviceSigning(p: { pdsUrl: string; jwt: string; did: string; phrase: string }): Promise<void> {
  const keys = await assertPhraseBelongs(p.pdsUrl, p.did, p.phrase);
  await disableDeviceSigning({ plcUrl: await plcDirectoryOf(p.pdsUrl), did: p.did, rotationPrivateKey: keys.rotationPrivateKey, client: clientFor(p.pdsUrl, p.jwt) });
  forgetDeviceKey(p.did);
}

async function latestOperation(plcUrl: string, did: string): Promise<SignedPlcOperation> {
  const res = await fetch(`${plcUrl}/${did}/log`);
  if (!res.ok) throw new MoveError('Could not read your identity from the public directory');
  const log = (await res.json()) as SignedPlcOperation[];
  const last = log[log.length - 1];
  if (!last || last.type !== 'plc_operation') throw new MoveError('Your identity has no current entry in the public directory');
  return last;
}

/**
 * This device takes over: a new key made here, named in your identity with
 * your 12 words or, if you do not have them at hand, your backup phrase
 * (recovery). A change signed with the backup phrase can be cancelled with
 * your 12 words for 72 hours (`cancelUntil`). Also rotates the key when this
 * device already holds one.
 */
export async function replaceDevice(p: {
  pdsUrl: string; jwt: string; did: string; handle: string; mode: RecoveryMode;
  with: { phrase: string } | { recoveryPhrase: string };
}): Promise<{ didKey: string; cancelUntil?: Date }> {
  const plcUrl = await plcDirectoryOf(p.pdsUrl);
  if ('phrase' in p.with) {
    const keys = await assertPhraseBelongs(p.pdsUrl, p.did, p.with.phrase);
    const didKey = await newSealedKey(p.did, p.handle);
    await setDeviceRepoKey({ plcUrl, did: p.did, rotationPrivateKey: keys.rotationPrivateKey, deviceDidKey: didKey });
    await call(p.pdsUrl, 'net.openfederation.account.enableDeviceSigning', { jwt: p.jwt, body: {} });
    return { didKey };
  }
  await assertRecoveryPhraseBelongs(p.pdsUrl, p.did, p.mode, p.with.recoveryPhrase);
  const recovery = deriveRecoveryKey(p.with.recoveryPhrase);
  const didKey = await newSealedKey(p.did, p.handle);
  const previous = await latestOperation(plcUrl, p.did);
  const submittedAt = Date.now();
  await submitPlcOperation(plcUrl, p.did, signPlcOperation(buildAtprotoKeyOp(previous, didKey), recovery.recoveryPrivateKey));
  await call(p.pdsUrl, 'net.openfederation.account.enableDeviceSigning', { jwt: p.jwt, body: {} });
  return { didKey, cancelUntil: new Date(submittedAt + CANCEL_WINDOW_MS) };
}

/** Off here, but your identity names a key that is not this server's (after a cancelled switch back): turn it on again. */
export async function resumeDeviceSigning(p: { pdsUrl: string; jwt: string }): Promise<void> {
  await call(p.pdsUrl, 'net.openfederation.account.enableDeviceSigning', { jwt: p.jwt, body: {} });
}

// ── A switch back by a lower key ─────────────────────────────────


export interface SwitchBack {
  createdAt: string;
  cancelUntil: Date;
  cancellable: boolean;
  /** The key that signed it ranks below your 12 words: 1 is your recovery (if you have one, or this server's backup in Assisted without recovery). */
  signerRank: number;
  /** Whether it pointed your identity at this server's key. */
  toServerKey: boolean;
  before: SignedPlcOperation;
}

/**
 * The latest change of the key that signs your posts, if a key below your 12
 * words made it (this server's backup in Assisted, or your recovery), read
 * from the public directory. Null when the latest such change was yours.
 */
export async function findSwitchBack(pdsUrl: string, did: string, serverKey: string | null): Promise<SwitchBack | null> {
  const res = await fetch(`${await plcDirectoryOf(pdsUrl)}/${did}/log/audit`);
  if (!res.ok) throw new MoveError('Could not read your identity history from the public directory');
  const live = ((await res.json()) as { createdAt: string; nullified: boolean; operation: SignedPlcOperation }[]).filter((e) => !e.nullified);
  for (let i = live.length - 1; i >= 1; i--) {
    const before = live[i - 1].operation;
    const op = live[i].operation;
    if (before.verificationMethods.atproto === op.verificationMethods.atproto) continue;
    const signer = plcOperationSigner(op, before.rotationKeys);
    const rank = signer ? before.rotationKeys.indexOf(signer) : -1;
    if (rank < 1) return null;
    const cancelUntil = new Date(new Date(live[i].createdAt).getTime() + CANCEL_WINDOW_MS);
    return {
      createdAt: live[i].createdAt, cancelUntil, cancellable: Date.now() < cancelUntil.getTime(), signerRank: rank,
      toServerKey: !!serverKey && op.verificationMethods.atproto === serverKey, before,
    };
  }
  return null;
}

/** Cancel it with your 12 words (they must rank above the key that made it), then turn device signing back on here. */
export async function cancelSwitchBack(p: { pdsUrl: string; jwt: string; did: string; phrase: string; change: SwitchBack }): Promise<void> {
  const keys = deriveCustodyKeys(p.phrase);
  const rank = p.change.before.rotationKeys.indexOf(keys.rotationDidKey);
  if (rank < 0 || rank >= p.change.signerRank) throw new MoveError('These 12 words cannot cancel this change: they are not the words that were in charge before it.');
  await submitPlcOperation(await plcDirectoryOf(p.pdsUrl), p.did, signPlcOperation(buildCancelOp(p.change.before), keys.rotationPrivateKey));
  await resumeDeviceSigning(p);
}

/**
 * Whether the latest change in your repository was signed by `didKey` (your
 * device). After a switch back this server may have written in your name;
 * then it was not, and the person should look at their records.
 */
export async function headSignedBy(pdsUrl: string, did: string, didKey: string): Promise<boolean | null> {
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`).catch(() => null);
  if (!res?.ok) return null;
  try {
    return verifyRepoCommit(readRepoCar(new Uint8Array(await res.arrayBuffer())).commit, didKey);
  } catch { return null; }
}
