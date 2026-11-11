/**
 * Person-signed records (ADR-003, decision 11). The PDS holds the repo key and
 * can write records as the user; a record that matters carries an extra field
 * the PDS cannot produce:
 *
 *   ownerSig: { cid, signature }
 *
 * `cid` is the CID (dag-cbor, sha-256, CIDv1) of the record's AT Protocol JSON
 * form without `ownerSig`. The owner key signs:
 *
 *   OpenFederation Owner Record v1
 *   did: <did>
 *   collection: <nsid>
 *   cid: <cid>
 *
 * so the signature can't be moved to another repo or collection. AT Protocol
 * allows unknown fields: generic apps ignore ownerSig.
 */
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from '@noble/hashes/sha2';
import { base32Lower } from './encoding.js';
import { verifyOwnerSignature, type OwnerSignature } from './owner-signature.js';

export interface OwnerSig { cid: string; signature: OwnerSignature }
export interface RecordContext { did: string; collection: string }

export function recordCid(record: Record<string, unknown>): string {
  const { ownerSig: _ownerSig, ...content } = record;
  const hash = sha256(dagCbor.encode(content));
  const bytes = new Uint8Array(4 + hash.length);
  bytes.set([0x01, 0x71, 0x12, 0x20]);
  bytes.set(hash, 4);
  return `b${base32Lower(bytes)}`;
}

export function ownerRecordText(p: RecordContext & { cid: string }): string {
  return `OpenFederation Owner Record v1\ndid: ${p.did}\ncollection: ${p.collection}\ncid: ${p.cid}`;
}

/** Sign with a key in hand (e.g. `(t) => signOwnerRaw(keys.ownerPrivateKey, t)`). */
export function signRecord<T extends Record<string, unknown>>(record: T, ctx: RecordContext, sign: (text: string) => OwnerSignature): T & { ownerSig: OwnerSig } {
  const cid = recordCid(record);
  return { ...record, ownerSig: { cid, signature: sign(ownerRecordText({ ...ctx, cid })) } };
}

/** Sign with a passkey (e.g. `(t) => signOwnerWithPasskey({ credentialId, text: t })`). */
export async function signRecordWithPasskey<T extends Record<string, unknown>>(record: T, ctx: RecordContext, sign: (text: string) => Promise<OwnerSignature>): Promise<T & { ownerSig: OwnerSig }> {
  const cid = recordCid(record);
  return { ...record, ownerSig: { cid, signature: await sign(ownerRecordText({ ...ctx, cid })) } };
}

export type OwnerRecordVerdict = { ok: true } | { ok: false; reason: 'NotSigned' | 'CidMismatch' | 'SignatureInvalid' };

/** Check a record against the owner key from the DID document's `openfederation_owner`. */
export function verifyOwnerRecord(record: Record<string, unknown>, ctx: RecordContext & { ownerDidKey: string }): OwnerRecordVerdict {
  const sig = record.ownerSig as OwnerSig | undefined;
  if (!sig || typeof sig !== 'object' || typeof sig.cid !== 'string' || !sig.signature) return { ok: false, reason: 'NotSigned' };
  if (recordCid(record) !== sig.cid) return { ok: false, reason: 'CidMismatch' };
  return verifyOwnerSignature(ownerRecordText({ ...ctx, cid: sig.cid }), sig.signature, ctx.ownerDidKey).ok
    ? { ok: true } : { ok: false, reason: 'SignatureInvalid' };
}
