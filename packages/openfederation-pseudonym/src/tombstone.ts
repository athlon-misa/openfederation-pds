/**
 * Retiring a pseudonym for good: a PLC tombstone, signed with its words.
 * The owner key is the DID's only rotation key, so nobody else can do this,
 * and once it is done the DID resolves to nothing. Delete the pseudonym's
 * accounts first (com.atproto.server.deleteAccount with an owner-key JWT):
 * servers check that JWT against the DID's current rotation keys, which a
 * tombstoned DID no longer has.
 */
import * as dagCbor from '@ipld/dag-cbor';
import { derivePseudonymKeys, signBytes } from './keys.js';
import { cidForPlcOp } from './plc.js';

export interface PlcTombstoneOp {
  type: 'plc_tombstone';
  /** CID of the operation it ends, as for any later operation. */
  prev: string;
}

export interface SignedPlcTombstoneOp extends PlcTombstoneOp {
  sig: string;
}

export function buildTombstoneOp(previous: object): PlcTombstoneOp {
  return { type: 'plc_tombstone', prev: cidForPlcOp(previous) };
}

export function signTombstoneOp(op: PlcTombstoneOp, privateKey: Uint8Array): SignedPlcTombstoneOp {
  return { ...op, sig: signBytes(privateKey, dagCbor.encode(op)) };
}

/**
 * Tombstone a pseudonym's DID in the PLC directory with its twelve words.
 * Refuses, before anything is sent, when the DID is already tombstoned or the
 * words are not its current rotation key. Returns the operation PLC accepted.
 */
export async function tombstone(p: { plcUrl: string; did: string; phrase: string }): Promise<SignedPlcTombstoneOp> {
  const keys = derivePseudonymKeys(p.phrase);
  const logRes = await fetch(`${p.plcUrl}/${p.did}/log`);
  if (!logRes.ok) throw new Error(`PLC log lookup failed (${logRes.status})`);
  const log = await logRes.json() as { type?: string; rotationKeys?: string[] }[];
  const last = log[log.length - 1];
  if (!last) throw new Error(`PLC has no operations for ${p.did}`);
  if (last.type === 'plc_tombstone') throw new Error(`AlreadyTombstoned: ${p.did} is already tombstoned`);
  if (!last.rotationKeys?.includes(keys.ownerDidKey)) {
    throw new Error(`NotRotationKey: these words are not a rotation key of ${p.did}`);
  }
  const op = signTombstoneOp(buildTombstoneOp(last), keys.ownerPrivateKey);
  const res = await fetch(`${p.plcUrl}/${p.did}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op),
  });
  if (!res.ok) throw new Error(`PLC refused the tombstone (${res.status}): ${await res.text()}`);
  return op;
}
