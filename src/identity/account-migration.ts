/**
 * Account migration: what this PDS needs to know about a DID arriving from
 * another PDS. The DID's current PLC state is the last operation in its log.
 */
import { verifySignature } from '@atproto/crypto';
import { encodeDagCbor, getPlcLog } from './plc-client.js';
import { getDidResolver } from './did-resolver.js';
import { commitmentsIn } from '../../packages/openfederation-pseudonym/src/formats.js';
import { cidForPlcOp } from '../../packages/openfederation-pseudonym/src/plc.js';

export interface PlcState {
  rotationKeys: string[];
  verificationMethods: Record<string, string>;
  alsoKnownAs: string[];
  services: Record<string, { type?: string; endpoint?: string }>;
}

/** Current PLC state, or null when the DID is unknown or tombstoned. */
export async function currentPlcState(did: string): Promise<PlcState | null> {
  const log = await getPlcLog(did);
  const last = log?.[log.length - 1];
  if (!last || last.type !== 'plc_operation') return null;
  const { rotationKeys, verificationMethods, alsoKnownAs, services } = last;
  if (!Array.isArray(rotationKeys) || !rotationKeys.every((k) => typeof k === 'string')) return null;
  return {
    rotationKeys: rotationKeys as string[],
    verificationMethods: (verificationMethods ?? {}) as Record<string, string>,
    alsoKnownAs: Array.isArray(alsoKnownAs) ? (alsoKnownAs as string[]) : [],
    services: (services ?? {}) as PlcState['services'],
  };
}

/**
 * A pseudonym keeps the shape of its genesis: one secp256k1 rotation key (the
 * owner key) and exactly one commitment entry in alsoKnownAs.
 */
export function pseudonymOwnerKeyOf(state: PlcState): string | null {
  if (state.rotationKeys.length !== 1 || !state.rotationKeys[0].startsWith('did:key:zQ3s')) return null;
  const urns = state.alsoKnownAs.filter((a) => a.startsWith('urn:openfederation:pseudonym-commitment:'));
  if (urns.length !== 1 || commitmentsIn(urns).length !== 1) return null;
  return state.rotationKeys[0];
}

/** True when the DID already names this PDS and the given key as its repo signing key. */
export function pointsHere(state: PlcState, serviceUrl: string, signingKey: string): boolean {
  return state.services.atproto_pds?.endpoint === serviceUrl && state.verificationMethods.atproto === signingKey;
}

/**
 * `pointsHere` for a user account that may have device signing on (#240):
 * then the DID names the device's key, so any key other than this server's
 * is the right one, and the endpoint must still be this server.
 */
export function accountPointsHere(state: PlcState, serviceUrl: string, serverKey: string, deviceSigning: boolean): boolean {
  if (!deviceSigning) return pointsHere(state, serviceUrl, serverKey);
  const key = state.verificationMethods.atproto;
  return state.services.atproto_pds?.endpoint === serviceUrl && typeof key === 'string' && key !== serverKey;
}

/**
 * Every atproto signing key the DID has had, oldest first. Empty for a DID
 * that is unknown or tombstoned (a deleted identity vouches for nothing). For
 * other DID methods only the current key is known.
 *
 * Used to check signatures on records written before a key rotation: those
 * were made with the key the DID had at the time.
 */
export async function atprotoKeyHistory(did: string): Promise<string[]> {
  if (!did.startsWith('did:plc:')) {
    const current = await atprotoKeyFor(did);
    return current ? [current] : [];
  }
  const log = await getPlcLog(did);
  if (!log || log.length === 0 || log[log.length - 1]?.type !== 'plc_operation') return [];
  const keys: string[] = [];
  for (const op of log) {
    const key = (op.verificationMethods as Record<string, unknown> | undefined)?.atproto;
    if (op.type === 'plc_operation' && typeof key === 'string' && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * The DID's current atproto signing key. For did:plc it is read from the PLC
 * log, uncached, so it reflects a move made seconds ago.
 */
export async function atprotoKeyFor(did: string): Promise<string | null> {
  if (did.startsWith('did:plc:')) return (await currentPlcState(did))?.verificationMethods.atproto ?? null;
  return getDidResolver().resolveAtprotoKey(did);
}

/**
 * ADR-004, decision 2: the `atproto` key a `self` account's repository may be
 * signed with, besides the current one, when the person moved the DID here
 * with their own key and the old PDS can't help. It is the key of the
 * operation immediately before the one that points the DID here, and only
 * when, in the DID's active PLC log (read uncached):
 *   - the last operation names this server and the one before does not, so
 *     the move here is the latest change;
 *   - the last operation's `prev` is the one before it;
 *   - the one before publishes `openfederation_owner` (an ADR-003 account);
 *   - the move is signed by that state's first rotation key (the person's,
 *     never a PDS's backup key, which ADR-003 lists below it), checked here,
 *     and keeps that key first.
 * Null otherwise: nothing older, no other signer.
 */
export async function atprotoKeyBeforeOwnMove(did: string, serviceUrl: string): Promise<string | null> {
  if (!did.startsWith('did:plc:')) return null;
  const log = await getPlcLog(did);
  if (!log || log.length < 2) return null;
  const moved = log[log.length - 1];
  const before = log[log.length - 2];
  if (moved.type !== 'plc_operation' || before.type !== 'plc_operation') return null;
  const endpointOf = (op: Record<string, unknown>) =>
    (op.services as PlcState['services'] | undefined)?.atproto_pds?.endpoint;
  if (endpointOf(moved) !== serviceUrl || endpointOf(before) === serviceUrl) return null;

  const methods = (before.verificationMethods ?? {}) as Record<string, unknown>;
  if (typeof methods.openfederation_owner !== 'string' || typeof methods.atproto !== 'string') return null;
  const beforeKeys = before.rotationKeys;
  const movedKeys = moved.rotationKeys;
  if (!Array.isArray(beforeKeys) || typeof beforeKeys[0] !== 'string') return null;
  if (!Array.isArray(movedKeys) || movedKeys[0] !== beforeKeys[0]) return null;
  if (moved.prev !== cidForPlcOp(before)) return null;

  const { sig, ...unsigned } = moved;
  if (typeof sig !== 'string') return null;
  let signedByPerson = false;
  try {
    signedByPerson = await verifySignature(beforeKeys[0], encodeDagCbor(unsigned), Buffer.from(sig, 'base64url'));
  } catch {
    signedByPerson = false;
  }
  return signedByPerson ? methods.atproto : null;
}
