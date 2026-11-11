/**
 * Person-signed records, checked on the server (ADR-003, decision 11). Same
 * rule as @open-federation/sdk/custody's verifyOwnerRecord, written
 * independently (another dag-cbor build, node's sha-256) so the tests catch a
 * disagreement between the two.
 */
import { createHash } from 'node:crypto';
import { encodeDagCbor } from './plc-client.js';
import { verifyOwnerSignature, type OwnerSignature } from './owner-signature.js';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes: Uint8Array): string {
  let bits = 0; let value = 0; let out = '';
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += B32[(value >>> bits) & 0x1f]; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 0x1f];
  return out;
}

export function recordContentCid(record: Record<string, unknown>): string {
  const { ownerSig: _ownerSig, ...content } = record;
  const hash = createHash('sha256').update(encodeDagCbor(content)).digest();
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x71, 0x12, 0x20]), hash]))}`;
}

export type OwnerRecordVerdict = { ok: true } | { ok: false; reason: 'NotSigned' | 'CidMismatch' | 'SignatureInvalid' };

export function verifyOwnerSignedRecord(
  record: Record<string, unknown>,
  ctx: { did: string; collection: string; ownerDidKey: string },
): OwnerRecordVerdict {
  const sig = record.ownerSig as { cid?: unknown; signature?: OwnerSignature } | undefined;
  if (!sig || typeof sig !== 'object' || typeof sig.cid !== 'string' || !sig.signature) return { ok: false, reason: 'NotSigned' };
  let cid: string;
  try { cid = recordContentCid(record); } catch { return { ok: false, reason: 'CidMismatch' }; }
  if (cid !== sig.cid) return { ok: false, reason: 'CidMismatch' };
  const text = `OpenFederation Owner Record v1\ndid: ${ctx.did}\ncollection: ${ctx.collection}\ncid: ${sig.cid}`;
  return verifyOwnerSignature(text, sig.signature, ctx.ownerDidKey).ok ? { ok: true } : { ok: false, reason: 'SignatureInvalid' };
}
