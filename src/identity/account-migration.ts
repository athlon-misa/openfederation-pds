/**
 * Account migration: what this PDS needs to know about a DID arriving from
 * another PDS. The DID's current PLC state is the last operation in its log.
 */
import { getPlcLog } from './plc-client.js';
import { getDidResolver } from './did-resolver.js';
import { commitmentsIn } from '../../packages/openfederation-pseudonym/src/formats.js';

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
 * The DID's current atproto signing key. For did:plc it is read from the PLC
 * log, uncached, so it reflects a move made seconds ago.
 */
export async function atprotoKeyFor(did: string): Promise<string | null> {
  if (did.startsWith('did:plc:')) return (await currentPlcState(did))?.verificationMethods.atproto ?? null;
  return getDidResolver().resolveAtprotoKey(did);
}
