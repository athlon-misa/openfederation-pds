/**
 * did:plc operations for `assisted` and `self` accounts (ADR-003, decisions 4
 * and 5). Rotation keys are listed by priority: the user's key first; in
 * `assisted`, the PDS's key second. The PDS keeps the `atproto` repo signing
 * key; the user's owner key is published as `openfederation_owner`.
 */
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { p256 } from '@noble/curves/p256';
import { base32Lower, base64UrlDecode, base64UrlEncode, parseDidKey } from './encoding.js';

export type SelfCustodyMode = 'assisted' | 'self';

export interface PlcService { type: 'AtprotoPersonalDataServer'; endpoint: string }

export interface PlcOperation {
  type: 'plc_operation';
  prev: string | null;
  rotationKeys: string[];
  verificationMethods: Record<string, string>;
  alsoKnownAs: string[];
  services: { atproto_pds: PlcService };
}

export type SignedPlcOperation = PlcOperation & { sig: string };

/** Rotation keys for a mode, by priority. */
export function rotationKeysFor(mode: SelfCustodyMode | 'custodial', keys: { userRotationDidKey?: string; pdsRotationDidKey?: string }): string[] {
  const need = (k: string | undefined, what: string) => { if (!k) throw new Error(`${what} is required for this mode`); return k; };
  if (mode === 'self') return [need(keys.userRotationDidKey, 'userRotationDidKey')];
  if (mode === 'assisted') return [need(keys.userRotationDidKey, 'userRotationDidKey'), need(keys.pdsRotationDidKey, 'pdsRotationDidKey')];
  return [need(keys.pdsRotationDidKey, 'pdsRotationDidKey')];
}

export function buildCustodyGenesisOp(p: {
  mode: SelfCustodyMode;
  userRotationDidKey: string;
  /** Required for `assisted`: the key the PDS made for itself. */
  pdsRotationDidKey?: string;
  /** The repo signing key the PDS reserved (com.atproto.server.reserveSigningKey). */
  atprotoDidKey: string;
  ownerDidKey: string;
  handle: string;
  pdsEndpoint: string;
}): PlcOperation {
  return {
    type: 'plc_operation',
    prev: null,
    rotationKeys: rotationKeysFor(p.mode, p),
    verificationMethods: { atproto: p.atprotoDidKey, openfederation_owner: p.ownerDidKey },
    alsoKnownAs: [`at://${p.handle}`],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: p.pdsEndpoint } },
  };
}

/**
 * The update that changes custody (decision 5): new rotation keys, the owner
 * key added (or removed for `custodial`), everything else as before.
 */
export function buildCustodyChangeOp(p: {
  previous: SignedPlcOperation;
  rotationKeys: string[];
  /** The owner key to publish; null removes it (a change to `custodial`). */
  ownerDidKey: string | null;
}): PlcOperation {
  const verificationMethods = { ...p.previous.verificationMethods };
  if (p.ownerDidKey) verificationMethods.openfederation_owner = p.ownerDidKey;
  else delete verificationMethods.openfederation_owner;
  return {
    type: 'plc_operation',
    prev: cidForPlcOp(p.previous),
    rotationKeys: [...p.rotationKeys],
    verificationMethods,
    alsoKnownAs: [...p.previous.alsoKnownAs],
    services: { atproto_pds: { ...p.previous.services.atproto_pds } },
  };
}

export function signPlcOperation(op: PlcOperation, rotationPrivateKey: Uint8Array): SignedPlcOperation {
  const sig = secp256k1.sign(sha256(dagCbor.encode(op)), rotationPrivateKey, { lowS: true }).toCompactRawBytes();
  return { ...op, sig: base64UrlEncode(sig) };
}

/** CIDv1 (dag-cbor, sha-256, base32): `prev` for a signed operation, or the id of an unsigned one. */
export function cidForPlcOp(op: object): string {
  const hash = sha256(dagCbor.encode(op));
  const bytes = new Uint8Array(4 + hash.length);
  bytes.set([0x01, 0x71, 0x12, 0x20]);
  bytes.set(hash, 4);
  return `b${base32Lower(bytes)}`;
}

/** A did:plc is the hash of its signed genesis operation. */
export function didForGenesisOp(signed: SignedPlcOperation): string {
  if (signed.prev !== null) throw new Error('Not a genesis operation');
  return `did:plc:${base32Lower(sha256(dagCbor.encode(signed))).slice(0, 24)}`;
}

/** Send a signed operation to a PLC directory. */
export async function submitPlcOperation(plcUrl: string, did: string, signed: SignedPlcOperation): Promise<void> {
  const res = await fetch(`${plcUrl.replace(/\/+$/, '')}/${did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signed),
  });
  if (!res.ok) throw new Error(`PLC refused the operation (${res.status}): ${await res.text()}`);
}

/**
 * Cancel an update within 72 hours (ADR-003, decision 10): PLC lets a rotation
 * key listed higher than the update's signer replace it. Pass the operation
 * *before* the one to cancel (`log[i - 1]` for `log[i]`); the result restores
 * that state. Sign it with the higher key (in `assisted`, the user's) and
 * submit it.
 */
export function buildCancelOp(before: SignedPlcOperation): PlcOperation {
  return {
    type: 'plc_operation',
    prev: cidForPlcOp(before),
    rotationKeys: [...before.rotationKeys],
    verificationMethods: { ...before.verificationMethods },
    alsoKnownAs: [...before.alsoKnownAs],
    services: { atproto_pds: { ...before.services.atproto_pds } },
  };
}

/**
 * Which of `rotationKeys` signed a PLC operation (the keys of the state
 * before it), or null. Tells a client whether a change was made by the
 * person's own key or by a lower one it may still cancel (buildCancelOp).
 */
export function plcOperationSigner(op: SignedPlcOperation, rotationKeys: string[]): string | null {
  const { sig, ...unsigned } = op;
  let sigBytes: Uint8Array;
  try { sigBytes = base64UrlDecode(sig); } catch { return null; }
  const digest = sha256(dagCbor.encode(unsigned));
  for (const key of rotationKeys) {
    try {
      const { curve, publicKey } = parseDidKey(key);
      const c = curve === 'secp256k1' ? secp256k1 : p256;
      if (c.verify(sigBytes, digest, publicKey, { lowS: false })) return key;
    } catch { /* not a key we can check */ }
  }
  return null;
}
