/**
 * Custody modes in the dashboard (docs/adr/ADR-003-custody-modes.md). The
 * phrase and the keys it derives exist only in this page; the server sees
 * did:keys and signatures.
 */
import {
  deriveCustodyKeys, signOwnerRaw, signPlcOperation, submitPlcOperation, buildCancelOp, plcOperationSigner,
  buildCustodyGenesisOp, didForGenesisOp,
  deriveRecoveryKey, recoveryKeyOf, addRecoveryKey, removeRecoveryKey, recoverWithRecoveryKey,
  type PlcOperation, type SignedPlcOperation,
} from '@open-federation/sdk/custody';
import { call, plcDirectoryOf, MoveError } from '@/lib/move/xrpc';

import type { CustodyMode } from '@/lib/copy/glossary';
export type { CustodyMode } from '@/lib/copy/glossary';

export interface IdentityPolicy { custodyAllowed: CustodyMode[]; custodyDefault: CustodyMode; pseudonymsEnabled: boolean }

export async function identityPolicy(pdsUrl: string): Promise<IdentityPolicy | null> {
  const config = await call<{ identity?: IdentityPolicy }>(pdsUrl, 'net.openfederation.server.getPublicConfig').catch(() => null);
  return config?.identity ?? null;
}

async function plcData(plcUrl: string, did: string): Promise<{ rotationKeys: string[]; verificationMethods: Record<string, string> }> {
  const res = await fetch(`${plcUrl}/${did}/data`);
  if (!res.ok) throw new MoveError('Could not read your identity from the public directory');
  return res.json();
}

/** Throws unless the phrase holds this account's current first rotation key. */
export async function assertPhraseBelongs(pdsUrl: string, did: string, phrase: string): Promise<ReturnType<typeof deriveCustodyKeys>> {
  const keys = deriveCustodyKeys(phrase);
  const data = await plcData(await plcDirectoryOf(pdsUrl), did);
  if (data.rotationKeys[0] !== keys.rotationDidKey) throw new MoveError('These 12 words do not belong to this account.');
  return keys;
}

export async function changeCustody(p: {
  pdsUrl: string; jwt: string; did: string; from: CustodyMode; to: CustodyMode; password: string;
  /** From custodial: the new phrase. Otherwise: the account's phrase. */
  phrase: string;
}): Promise<void> {
  if (p.from === 'custodial') {
    const keys = deriveCustodyKeys(p.phrase);
    const newKeys = { userRotationDidKey: keys.rotationDidKey, ownerDidKey: keys.ownerDidKey };
    const prep = await call<{ operationCid: string; possessionText: string }>(p.pdsUrl, 'net.openfederation.identity.prepareCustodyChange', {
      jwt: p.jwt, body: { password: p.password, targetMode: p.to, ...newKeys },
    });
    const possession = { rotation: signOwnerRaw(keys.rotationPrivateKey, prep.possessionText), owner: signOwnerRaw(keys.ownerPrivateKey, prep.possessionText) };
    await call(p.pdsUrl, 'net.openfederation.identity.finalizeCustodyChange', {
      jwt: p.jwt, body: { password: p.password, targetMode: p.to, ...newKeys, operationCid: prep.operationCid, possession },
    });
    return;
  }
  const keys = await assertPhraseBelongs(p.pdsUrl, p.did, p.phrase);
  const prep = await call<{ operation: PlcOperation; operationCid: string; pdsRotationDidKey?: string }>(p.pdsUrl, 'net.openfederation.identity.prepareCustodyChange', {
    jwt: p.jwt, body: { password: p.password, targetMode: p.to },
  });
  await submitPlcOperation(await plcDirectoryOf(p.pdsUrl), p.did, signPlcOperation(prep.operation, keys.rotationPrivateKey));
  await call(p.pdsUrl, 'net.openfederation.identity.finalizeCustodyChange', {
    jwt: p.jwt, body: { password: p.password, targetMode: p.to, operationCid: prep.operationCid, ...(prep.pdsRotationDidKey ? { pdsRotationDidKey: prep.pdsRotationDidKey } : {}) },
  });
}

const CANCEL_WINDOW_MS = 72 * 60 * 60 * 1000;

export interface IdentityChange {
  cid: string;
  createdAt: string;
  summary: string[];
  /** The operation before it: cancelling restores this state. */
  before: SignedPlcOperation;
  /**
   * Whether a higher key can still cancel it: it was signed by a rotation key
   * other than the first (in `assisted`, the server's backup). A change the
   * person signed with the top key can't be cancelled.
   */
  cancellable: boolean;
  /** A key below the phrase key signed it: the server's backup key (assisted) or the person's recovery key (#238). */
  signedByLowerKey: boolean;
  /** The did:key that signed it, when known. */
  signedBy?: string | null;
  /** Its place among the rotation keys before the change (0 = the top key; -1 = unknown). */
  signerRank?: number;
  /** Before the change, the person held a key of their own (assisted or self). */
  personHeld?: boolean;
}

export const CANCEL_WINDOW = CANCEL_WINDOW_MS;


function describe(before: SignedPlcOperation, after: SignedPlcOperation): string[] {
  const out: string[] = [];
  if (JSON.stringify(before.rotationKeys) !== JSON.stringify(after.rotationKeys)) out.push('who controls your identity');
  if (before.verificationMethods.openfederation_owner !== after.verificationMethods.openfederation_owner) out.push('the key you sign statements with');
  if (before.verificationMethods.atproto !== after.verificationMethods.atproto) out.push('the key your posts are signed with');
  if (before.services.atproto_pds.endpoint !== after.services.atproto_pds.endpoint) out.push(`your server (now ${after.services.atproto_pds.endpoint.replace(/^https?:\/\//, '')})`);
  if (JSON.stringify(before.alsoKnownAs) !== JSON.stringify(after.alsoKnownAs)) out.push('your handle');
  return out.length ? out : ['nothing: it put back an earlier state (a cancellation)'];
}

/** Every change to the DID, newest first; those within 72 hours that a higher key can cancel are marked. */
export async function identityHistory(pdsUrl: string, did: string): Promise<{ created: string | null; changes: IdentityChange[] }> {
  const res = await fetch(`${await plcDirectoryOf(pdsUrl)}/${did}/log/audit`);
  if (!res.ok) throw new MoveError('Could not read your identity history from the public directory');
  const audit = (await res.json()) as { cid: string; createdAt: string; nullified: boolean; operation: SignedPlcOperation }[];
  const live = audit.filter((e) => !e.nullified);
  const changes: IdentityChange[] = [];
  for (let i = 1; i < live.length; i++) {
    const recent = Date.now() - new Date(live[i].createdAt).getTime() <= CANCEL_WINDOW_MS;
    const before = live[i - 1].operation;
    const signer = plcOperationSigner(live[i].operation, before.rotationKeys);
    const index = signer ? before.rotationKeys.indexOf(signer) : -1;
    const lower = index > 0;
    changes.push({
      cid: live[i].cid, createdAt: live[i].createdAt, summary: describe(before, live[i].operation), before,
      cancellable: lower && recent, signedByLowerKey: lower,
      signedBy: signer, signerRank: index,
      personHeld: !!before.verificationMethods.openfederation_owner,
    });
  }
  return { created: live[0]?.createdAt ?? null, changes: changes.reverse() };
}

/** Changes to the DID in the last 72 hours. */
export async function recentIdentityChanges(pdsUrl: string, did: string): Promise<IdentityChange[]> {
  const { changes } = await identityHistory(pdsUrl, did);
  return changes.filter((c) => Date.now() - new Date(c.createdAt).getTime() <= CANCEL_WINDOW_MS);
}

export async function cancelIdentityChange(p: { pdsUrl: string; did: string; phrase: string; change: IdentityChange }): Promise<void> {
  const keys = await assertPhraseBelongs(p.pdsUrl, p.did, p.phrase).catch(async (e) => {
    // After a server-signed recovery the user's key is no longer first; the old phrase still cancels.
    const k = deriveCustodyKeys(p.phrase);
    if (p.change.before.rotationKeys[0] === k.rotationDidKey) return k;
    throw e;
  });
  await submitPlcOperation(await plcDirectoryOf(p.pdsUrl), p.did, signPlcOperation(buildCancelOp(p.change.before), keys.rotationPrivateKey));
}

/** The phrase remembered on this device (passkey-encrypted), per account. */
const storeKey = (did: string) => `of.custody.remembered.${did}`;
export function loadRemembered(did: string): unknown | null {
  try { const raw = localStorage.getItem(storeKey(did)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function saveRemembered(did: string, blob: unknown): void {
  try { localStorage.setItem(storeKey(did), JSON.stringify(blob)); } catch { /* storage unavailable: keep using the phrase */ }
}
export function forgetRemembered(did: string): void {
  try { localStorage.removeItem(storeKey(did)); } catch { /* nothing to forget */ }
}

/**
 * Sign-up for an `assisted` or `self` account (ADR-003, decision 4): keys
 * from the phrase, a signing key (and for assisted the server's backup key)
 * reserved on this server, the DID put in PLC, then registration.
 */
export async function registerWithOwnKeys(p: {
  pdsUrl: string; mode: 'assisted' | 'self'; phrase: string; handle: string; email: string; password: string; inviteCode?: string;
}): Promise<{ did: string }> {
  const keys = deriveCustodyKeys(p.phrase);
  const described = await call<{ availableUserDomains?: string[] }>(p.pdsUrl, 'com.atproto.server.describeServer');
  const suffix = described.availableUserDomains?.[0];
  if (!suffix) throw new MoveError('This server does not say which handle domain it uses');
  const { signingKey } = await call<{ signingKey: string }>(p.pdsUrl, 'com.atproto.server.reserveSigningKey', { body: {} });
  const pdsRotationDidKey = p.mode === 'assisted'
    ? (await call<{ rotationKey: string }>(p.pdsUrl, 'net.openfederation.account.reserveCustodyKey', { body: {} })).rotationKey
    : undefined;
  const genesis = signPlcOperation(buildCustodyGenesisOp({
    mode: p.mode, userRotationDidKey: keys.rotationDidKey, pdsRotationDidKey, atprotoDidKey: signingKey,
    ownerDidKey: keys.ownerDidKey, handle: `${p.handle}${suffix}`, pdsEndpoint: p.pdsUrl,
  }), keys.rotationPrivateKey);
  const did = didForGenesisOp(genesis);
  await submitPlcOperation(await plcDirectoryOf(p.pdsUrl), did, genesis);
  await call(p.pdsUrl, 'net.openfederation.account.registerSelfCustody', {
    body: { did, mode: p.mode, handle: p.handle, email: p.email, password: p.password, ...(p.inviteCode ? { inviteCode: p.inviteCode } : {}) },
  });
  return { did };
}

/**
 * An `assisted` account that lost its phrase (ADR-003, decision 10). Needs a
 * recent identity verification by the server's operator. The server signs,
 * with its backup key, an update that puts the new phrase's keys first.
 */
export async function recoverWithNewPhrase(p: { pdsUrl: string; jwt: string; password: string; phrase: string }): Promise<{ cancelUntil: string }> {
  const keys = deriveCustodyKeys(p.phrase);
  const base = { password: p.password, userRotationDidKey: keys.rotationDidKey, ownerDidKey: keys.ownerDidKey };
  const plan = await call<{ operationCid: string; possessionText: string }>(p.pdsUrl, 'net.openfederation.identity.recoverAssistedAccount', { jwt: p.jwt, body: base });
  const possession = { rotation: signOwnerRaw(keys.rotationPrivateKey, plan.possessionText), owner: signOwnerRaw(keys.ownerPrivateKey, plan.possessionText) };
  return call(p.pdsUrl, 'net.openfederation.identity.recoverAssistedAccount', {
    jwt: p.jwt, body: { ...base, operationCid: plan.operationCid, possession },
  });
}

/*
 * Optional recovery key (#238, ADR-003 decision 13): a second rotation key the
 * person holds, below the phrase key, kept as a backup phrase or split into
 * shares. These are PLC operations signed here; the server is not involved.
 */

export type RecoveryMode = 'assisted' | 'self';

/** The DID's recovery key, read from PLC, or null when it has none. */
export async function currentRecoveryKey(pdsUrl: string, did: string, mode: RecoveryMode): Promise<string | null> {
  const data = await plcData(await plcDirectoryOf(pdsUrl), did);
  return recoveryKeyOf(data.rotationKeys, mode);
}

/** Add the key of `recoveryPhrase`, signed with the identity phrase. */
export async function setUpRecovery(p: { pdsUrl: string; did: string; mode: RecoveryMode; phrase: string; recoveryPhrase: string }): Promise<void> {
  const keys = await assertPhraseBelongs(p.pdsUrl, p.did, p.phrase);
  await addRecoveryKey({
    plcUrl: await plcDirectoryOf(p.pdsUrl), did: p.did, mode: p.mode,
    rotationPrivateKey: keys.rotationPrivateKey, recoveryDidKey: deriveRecoveryKey(p.recoveryPhrase).recoveryDidKey,
  });
}

/** Take the recovery key out, signed with the identity phrase. */
export async function removeRecovery(p: { pdsUrl: string; did: string; mode: RecoveryMode; phrase: string }): Promise<void> {
  const keys = await assertPhraseBelongs(p.pdsUrl, p.did, p.phrase);
  await removeRecoveryKey({ plcUrl: await plcDirectoryOf(p.pdsUrl), did: p.did, mode: p.mode, rotationPrivateKey: keys.rotationPrivateKey });
}

/** Throws unless the recovery phrase (typed, or combined from shares) holds this account's recovery key. */
export async function assertRecoveryPhraseBelongs(pdsUrl: string, did: string, mode: RecoveryMode, recoveryPhrase: string): Promise<void> {
  const current = await currentRecoveryKey(pdsUrl, did, mode);
  if (!current) throw new MoveError('This account has no recovery set up.');
  if (deriveRecoveryKey(recoveryPhrase).recoveryDidKey !== current) {
    throw new MoveError('This backup does not belong to this account (it may be an older one, or another account\'s).');
  }
}

/**
 * The identity phrase was lost: the recovery key signs the new phrase in. The
 * old phrase can cancel it until `cancelUntil`; the recovery key stays.
 */
export async function recoverWithRecoveryPhrase(p: { pdsUrl: string; did: string; mode: RecoveryMode; recoveryPhrase: string; newPhrase: string }): Promise<{ cancelUntil: Date }> {
  await assertRecoveryPhraseBelongs(p.pdsUrl, p.did, p.mode, p.recoveryPhrase);
  const fresh = deriveCustodyKeys(p.newPhrase);
  const { cancelUntil } = await recoverWithRecoveryKey({
    plcUrl: await plcDirectoryOf(p.pdsUrl), did: p.did,
    recoveryPrivateKey: deriveRecoveryKey(p.recoveryPhrase).recoveryPrivateKey,
    newRotationDidKey: fresh.rotationDidKey, newOwnerDidKey: fresh.ownerDidKey,
  });
  return { cancelUntil };
}
