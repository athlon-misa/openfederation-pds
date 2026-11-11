/**
 * Checks a did:plc genesis operation for an `assisted` or `self` account
 * (ADR-003, decision 4) before this PDS hosts it. The rotation keys must be
 * exactly what the mode says, by priority: the user's key, then (assisted)
 * the key this PDS reserved. The user's key signs the operation.
 */
import { verifySignature } from '@atproto/crypto';
import { didForSignedOperation, encodeDagCbor } from './plc-client.js';

export type CustodyGenesisCheck =
  | { ok: true; handle: string; userRotationKey: string; pdsRotationKey: string | null; signingKey: string; ownerKey: string }
  | { ok: false; reason: string };

const SECP256K1_DID_KEY = /^did:key:zQ3s[1-9A-HJ-NP-Za-km-z]+$/;
const OWNER_DID_KEY = /^did:key:z(Q3s|Dn)[1-9A-HJ-NP-Za-km-z]+$/; // secp256k1 or P-256

export async function checkCustodyGenesis(
  did: string,
  op: Record<string, unknown>,
  mode: 'assisted' | 'self',
  expect: { serviceUrl: string; handle: string },
): Promise<CustodyGenesisCheck> {
  if (op.type !== 'plc_operation' || op.prev !== null || typeof op.sig !== 'string') return { ok: false, reason: 'NotGenesis' };
  if (didForSignedOperation(op) !== did) return { ok: false, reason: 'DidMismatch' };

  const rotationKeys = op.rotationKeys;
  const wanted = mode === 'self' ? 1 : 2;
  if (!Array.isArray(rotationKeys) || rotationKeys.length !== wanted
    || !rotationKeys.every((k) => typeof k === 'string' && SECP256K1_DID_KEY.test(k))
    || new Set(rotationKeys).size !== rotationKeys.length) {
    return { ok: false, reason: `RotationKeysDoNotMatchMode (${mode} needs ${wanted === 1 ? "only the user's key" : "the user's key, then this server's"})` };
  }
  const [userRotationKey, pdsRotationKey] = rotationKeys as string[];

  const { sig, ...unsigned } = op;
  let sigOk = false;
  try { sigOk = await verifySignature(userRotationKey, encodeDagCbor(unsigned), Buffer.from(sig as string, 'base64url')); } catch { sigOk = false; }
  if (!sigOk) return { ok: false, reason: 'NotSignedByUserKey' };

  const services = op.services as Record<string, { endpoint?: string }> | undefined;
  if (services?.atproto_pds?.endpoint !== expect.serviceUrl) return { ok: false, reason: 'WrongService' };

  const aka = Array.isArray(op.alsoKnownAs) ? (op.alsoKnownAs as unknown[]) : [];
  const handles = aka.filter((a): a is string => typeof a === 'string' && a.startsWith('at://')).map((a) => a.slice(5));
  if (handles.length !== 1 || handles[0] !== expect.handle) return { ok: false, reason: 'HandleMismatch' };

  const vm = (op.verificationMethods ?? {}) as Record<string, unknown>;
  if (typeof vm.atproto !== 'string') return { ok: false, reason: 'NoSigningKey' };
  if (typeof vm.openfederation_owner !== 'string' || !OWNER_DID_KEY.test(vm.openfederation_owner)) return { ok: false, reason: 'NoOwnerKey' };

  return { ok: true, handle: handles[0], userRotationKey, pdsRotationKey: pdsRotationKey ?? null, signingKey: vm.atproto, ownerKey: vm.openfederation_owner };
}
