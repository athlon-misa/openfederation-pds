/**
 * Optional recovery for `self` and `assisted` identities (#238, ADR-003
 * decision 13). The recovery key is a second rotation key the person holds,
 * listed directly below their phrase key:
 *
 *   self      [phraseKey, recoveryKey]
 *   assisted  [phraseKey, recoveryKey, pdsBackupKey]
 *
 * The PDS never holds it and takes no part: these are PLC operations signed
 * on the device. With the recovery key the person signs an update that puts
 * a new phrase's key first. Because the recovery key ranks below the phrase
 * key, the old phrase can cancel such an update for 72 hours (buildCancelOp),
 * so a recovery someone else starts fails while the real person still has
 * their phrase.
 *
 * The recovery key comes from its own 12-word recovery phrase, derived at
 * m/1985'/2': a path the identity phrase never uses, so the two keys differ
 * even if the same words were typed for both.
 */
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1';
import { didKeyFor, parseDidKey } from './encoding.js';
import { generateCustodyPhrase, normalizePhrase } from './keys.js';
import { cidForPlcOp, signPlcOperation, type PlcOperation, type SelfCustodyMode, type SignedPlcOperation } from './plc.js';

export const RECOVERY_KEY_PATH = "m/1985'/2'";

/** How long a higher rotation key can cancel an update signed by a lower one (PLC's rule). */
export const PLC_CANCEL_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface RecoveryKey {
  recoveryPrivateKey: Uint8Array;
  recoveryDidKey: string;
}

/** A fresh 12-word recovery phrase, made on the device. Keep it apart from the identity phrase (paper, safe). */
export function generateRecoveryPhrase(): string {
  return generateCustodyPhrase();
}

export function deriveRecoveryKey(recoveryPhrase: string): RecoveryKey {
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(normalizePhrase(recoveryPhrase), '')).derive(RECOVERY_KEY_PATH).privateKey;
  if (!key) throw new Error('InvalidPhrase');
  return { recoveryPrivateKey: key, recoveryDidKey: didKeyFor('secp256k1', secp256k1.getPublicKey(key, true)) };
}

/** Rotation keys of a mode without recovery: 1 for `self`, 2 for `assisted`. */
const BASE_KEYS: Record<SelfCustodyMode, number> = { self: 1, assisted: 2 };

function nextOp(previous: SignedPlcOperation, rotationKeys: string[], verificationMethods = previous.verificationMethods): PlcOperation {
  return {
    type: 'plc_operation',
    prev: cidForPlcOp(previous),
    rotationKeys,
    verificationMethods: { ...verificationMethods },
    alsoKnownAs: [...previous.alsoKnownAs],
    services: { atproto_pds: { ...previous.services.atproto_pds } },
  };
}

function checkDidKey(key: string, what: string): void {
  try { parseDidKey(key); } catch { throw new Error(`${what} must be a secp256k1 or P-256 did:key`); }
}

/**
 * The update that lists `recoveryDidKey` directly below the phrase key,
 * everything else as before. Refuses when the DID already has a recovery
 * key (more rotation keys than `mode` has without one).
 */
export function buildAddRecoveryKeyOp(p: { previous: SignedPlcOperation; mode: SelfCustodyMode; recoveryDidKey: string }): PlcOperation {
  checkDidKey(p.recoveryDidKey, 'recoveryDidKey');
  const keys = p.previous.rotationKeys;
  if (keys.includes(p.recoveryDidKey)) throw new Error('This key is already a rotation key of the DID');
  if (keys.length > BASE_KEYS[p.mode]) throw new Error('The DID already has a recovery key; remove it first');
  if (keys.length < BASE_KEYS[p.mode]) throw new Error(`The DID's rotation keys do not look like a ${p.mode} account`);
  return nextOp(p.previous, [keys[0], p.recoveryDidKey, ...keys.slice(1)]);
}

/** The recovery key of a DID in `mode`: the key directly below the phrase key, or null. */
export function recoveryKeyOf(rotationKeys: string[], mode: SelfCustodyMode): string | null {
  return rotationKeys.length === BASE_KEYS[mode] + 1 ? rotationKeys[1] : null;
}

/** The update that takes the recovery key out, everything else as before. */
export function buildRemoveRecoveryKeyOp(p: { previous: SignedPlcOperation; mode: SelfCustodyMode }): PlcOperation {
  const recovery = recoveryKeyOf(p.previous.rotationKeys, p.mode);
  if (!recovery) throw new Error('The DID has no recovery key');
  return nextOp(p.previous, p.previous.rotationKeys.filter((k) => k !== recovery));
}

/**
 * The recovery update: the new phrase's rotation key first and its owner key
 * as `openfederation_owner`; then the recovery key (or `newRecoveryDidKey`);
 * then the other keys as before (in `assisted`, the PDS's backup key). The
 * lost phrase key goes. Sign it with the recovery key.
 */
export function buildRecoveryOp(p: {
  previous: SignedPlcOperation;
  recoveryDidKey: string;
  newRotationDidKey: string;
  newOwnerDidKey: string;
  newRecoveryDidKey?: string;
}): PlcOperation {
  checkDidKey(p.newRotationDidKey, 'newRotationDidKey');
  checkDidKey(p.newOwnerDidKey, 'newOwnerDidKey');
  if (p.newRecoveryDidKey) checkDidKey(p.newRecoveryDidKey, 'newRecoveryDidKey');
  const keys = p.previous.rotationKeys;
  const at = keys.indexOf(p.recoveryDidKey);
  if (at < 1) throw new Error(at === 0 ? 'The recovery key is already the first rotation key' : 'This key is not a rotation key of the DID');
  const recovery = p.newRecoveryDidKey ?? p.recoveryDidKey;
  const rest = keys.slice(1).filter((k) => k !== p.recoveryDidKey);
  const rotationKeys = [p.newRotationDidKey, recovery, ...rest];
  if (new Set(rotationKeys).size !== rotationKeys.length) throw new Error('The new keys must differ from the rotation keys the DID keeps');
  return nextOp(p.previous, rotationKeys, { ...p.previous.verificationMethods, openfederation_owner: p.newOwnerDidKey });
}

type Fetch = typeof globalThis.fetch;

interface PlcIo { plcUrl: string; did: string; fetch?: Fetch }

export interface RecoveryKeyChange {
  previous: SignedPlcOperation;
  operation: SignedPlcOperation;
}

export interface RecoveryResult extends RecoveryKeyChange {
  /** Until when the old phrase can cancel the recovery (buildCancelOp on `previous`). */
  cancelUntil: Date;
}

function io(p: PlcIo): { plc: string; doFetch: Fetch } {
  return {
    plc: p.plcUrl.replace(/\/+$/, ''),
    doFetch: p.fetch ?? ((...args: Parameters<Fetch>) => globalThis.fetch(...args)),
  };
}

async function currentOp(p: PlcIo): Promise<SignedPlcOperation> {
  const { plc, doFetch } = io(p);
  const res = await doFetch(`${plc}/${p.did}/log`);
  if (!res.ok) throw new Error(`PLC log lookup failed (${res.status})`);
  const log = await res.json() as Array<SignedPlcOperation | { type: string }>;
  const previous = log[log.length - 1] as SignedPlcOperation | undefined;
  if (!previous || previous.type !== 'plc_operation') throw new Error('The DID has no current PLC operation (deleted, or a legacy format)');
  return previous;
}

/** Submit, then check PLC shows the update's keys. */
async function submitAndCheck(p: PlcIo, operation: SignedPlcOperation): Promise<void> {
  const { plc, doFetch } = io(p);
  const submitted = await doFetch(`${plc}/${p.did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
  });
  if (!submitted.ok) throw new Error(`PLC refused the operation (${submitted.status}): ${await submitted.text()}`);
  const dataRes = await doFetch(`${plc}/${p.did}/data`);
  if (!dataRes.ok) throw new Error(`PLC read-back failed (${dataRes.status})`);
  const data = await dataRes.json() as { rotationKeys?: string[]; verificationMethods?: Record<string, string> };
  if (JSON.stringify(data.rotationKeys) !== JSON.stringify(operation.rotationKeys)
    || data.verificationMethods?.openfederation_owner !== operation.verificationMethods.openfederation_owner) {
    throw new Error('PLC does not show the update');
  }
}

function signerDidKey(privateKey: Uint8Array): string {
  return didKeyFor('secp256k1', secp256k1.getPublicKey(privateKey, true));
}

function requirePhraseKey(previous: SignedPlcOperation, rotationPrivateKey: Uint8Array): void {
  if (previous.rotationKeys[0] !== signerDidKey(rotationPrivateKey)) {
    throw new Error("This phrase's key is not the DID's first rotation key; PLC would refuse the update or it could be cancelled");
  }
}

/**
 * Add a recovery key, signed with the identity phrase's rotation key
 * (`deriveCustodyKeys(phrase).rotationPrivateKey`), and check PLC shows it.
 * `recoveryDidKey` is usually `deriveRecoveryKey(recoveryPhrase).recoveryDidKey`.
 */
export async function addRecoveryKey(p: PlcIo & { rotationPrivateKey: Uint8Array; mode: SelfCustodyMode; recoveryDidKey: string }): Promise<RecoveryKeyChange> {
  const previous = await currentOp(p);
  requirePhraseKey(previous, p.rotationPrivateKey);
  const operation = signPlcOperation(buildAddRecoveryKeyOp({ previous, mode: p.mode, recoveryDidKey: p.recoveryDidKey }), p.rotationPrivateKey);
  await submitAndCheck(p, operation);
  return { previous, operation };
}

/** Take the recovery key out, signed with the identity phrase's rotation key. Works without the recovery phrase. */
export async function removeRecoveryKey(p: PlcIo & { rotationPrivateKey: Uint8Array; mode: SelfCustodyMode }): Promise<RecoveryKeyChange> {
  const previous = await currentOp(p);
  requirePhraseKey(previous, p.rotationPrivateKey);
  const operation = signPlcOperation(buildRemoveRecoveryKeyOp({ previous, mode: p.mode }), p.rotationPrivateKey);
  await submitAndCheck(p, operation);
  return { previous, operation };
}

/**
 * Recover a lost phrase with the recovery key: the new phrase's keys
 * (`deriveCustodyKeys(newPhrase)`) go first, signed by the recovery key.
 * The old phrase can cancel it until `cancelUntil`; the custody mode does
 * not change.
 */
export async function recoverWithRecoveryKey(p: PlcIo & {
  recoveryPrivateKey: Uint8Array;
  newRotationDidKey: string;
  newOwnerDidKey: string;
  /** Replace the recovery key too (for example when it may have been seen). */
  newRecoveryDidKey?: string;
}): Promise<RecoveryResult> {
  const previous = await currentOp(p);
  const recoveryDidKey = signerDidKey(p.recoveryPrivateKey);
  const operation = signPlcOperation(buildRecoveryOp({
    previous, recoveryDidKey, newRotationDidKey: p.newRotationDidKey, newOwnerDidKey: p.newOwnerDidKey, newRecoveryDidKey: p.newRecoveryDidKey,
  }), p.recoveryPrivateKey);
  // Taken before PLC stamps the operation, so the deadline is never later than PLC's.
  const submittedAt = Date.now();
  await submitAndCheck(p, operation);
  return { previous, operation, cancelUntil: new Date(submittedAt + PLC_CANCEL_WINDOW_MS) };
}
