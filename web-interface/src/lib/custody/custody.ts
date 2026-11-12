/**
 * Custody modes in the dashboard (docs/adr/ADR-003-custody-modes.md). The
 * phrase and the keys it derives exist only in this page; the server sees
 * did:keys and signatures.
 */
import {
  deriveCustodyKeys, signOwnerRaw, signPlcOperation, submitPlcOperation, buildCancelOp, plcOperationSigner,
  buildCustodyGenesisOp, didForGenesisOp,
  type PlcOperation, type SignedPlcOperation,
} from '@open-federation/sdk/custody';
import { call, plcDirectoryOf, MoveError } from '@/lib/move/xrpc';

export type CustodyMode = 'custodial' | 'assisted' | 'self';

export const MODE_TEXT: Record<CustodyMode, { title: string; what: string }> = {
  custodial: { title: 'Custodial', what: 'This server holds the key that controls your identity. If you lose access, the server can restore it.' },
  assisted: { title: 'Assisted', what: 'You hold the key that controls your identity; this server keeps a backup key. If the server ever uses it, you are emailed and can cancel the change for 72 hours with your phrase.' },
  self: { title: 'Self', what: 'Only you hold the key that controls your identity, in your 12-word phrase. Nobody, including this server, can restore it if you lose the phrase.' },
};

export interface IdentityPolicy { custodyAllowed: CustodyMode[]; custodyDefault: CustodyMode; pseudonymsEnabled: boolean }

export async function identityPolicy(pdsUrl: string): Promise<IdentityPolicy | null> {
  const config = await call<{ identity?: IdentityPolicy }>(pdsUrl, 'net.openfederation.server.getPublicConfig').catch(() => null);
  return config?.identity ?? null;
}

async function plcData(plcUrl: string, did: string): Promise<{ rotationKeys: string[]; verificationMethods: Record<string, string> }> {
  const res = await fetch(`${plcUrl}/${did}/data`);
  if (!res.ok) throw new MoveError('Could not read your identity from the PLC directory');
  return res.json();
}

/** Throws unless the phrase holds this account's current first rotation key. */
export async function assertPhraseBelongs(pdsUrl: string, did: string, phrase: string): Promise<ReturnType<typeof deriveCustodyKeys>> {
  const keys = deriveCustodyKeys(phrase);
  const data = await plcData(await plcDirectoryOf(pdsUrl), did);
  if (data.rotationKeys[0] !== keys.rotationDidKey) throw new MoveError('This phrase does not belong to this account.');
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
  /** The server's backup key signed it (in assisted: a recovery or a server-signed move). */
  signedByLowerKey: boolean;
}

const CANCEL_WINDOW_MS = 72 * 60 * 60 * 1000;

function describe(before: SignedPlcOperation, after: SignedPlcOperation): string[] {
  const out: string[] = [];
  if (JSON.stringify(before.rotationKeys) !== JSON.stringify(after.rotationKeys)) out.push('who controls the identity (rotation keys)');
  if (before.verificationMethods.openfederation_owner !== after.verificationMethods.openfederation_owner) out.push('the owner key');
  if (before.verificationMethods.atproto !== after.verificationMethods.atproto) out.push('the signing key');
  if (before.services.atproto_pds.endpoint !== after.services.atproto_pds.endpoint) out.push(`the server (now ${after.services.atproto_pds.endpoint})`);
  if (JSON.stringify(before.alsoKnownAs) !== JSON.stringify(after.alsoKnownAs)) out.push('the handle');
  return out.length ? out : ['nothing changed: it restored the state before (a cancellation)'];
}

/** Changes to the DID in the last 72 hours that a higher key can still cancel. */
export async function recentIdentityChanges(pdsUrl: string, did: string): Promise<IdentityChange[]> {
  const res = await fetch(`${await plcDirectoryOf(pdsUrl)}/${did}/log/audit`);
  if (!res.ok) throw new MoveError('Could not read your identity history from the PLC directory');
  const audit = (await res.json()) as { cid: string; createdAt: string; nullified: boolean; operation: SignedPlcOperation }[];
  const live = audit.filter((e) => !e.nullified);
  const changes: IdentityChange[] = [];
  for (let i = 1; i < live.length; i++) {
    if (Date.now() - new Date(live[i].createdAt).getTime() > CANCEL_WINDOW_MS) continue;
    const before = live[i - 1].operation;
    const signer = plcOperationSigner(live[i].operation, before.rotationKeys);
    const lower = !!signer && before.rotationKeys.indexOf(signer) > 0;
    changes.push({ cid: live[i].cid, createdAt: live[i].createdAt, summary: describe(before, live[i].operation), before, cancellable: lower, signedByLowerKey: lower });
  }
  return changes.reverse();
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
