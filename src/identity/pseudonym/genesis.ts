/**
 * Validates a pseudonym's PLC genesis operation before this PDS hosts it.
 */
import { verifySignature } from '@atproto/crypto';
import { didForSignedOperation, encodeDagCbor } from '../plc-client.js';
import { commitmentsIn, base64UrlDecode } from '../../../packages/openfederation-pseudonym/src/formats.js';

export type GenesisCheck =
  | { ok: true; handle: string; ownerKey: string; signingKey: string }
  | { ok: false; reason: string };

export async function checkPseudonymGenesis(
  did: string,
  op: Record<string, unknown>,
  expect: { serviceUrl: string; handleSuffix: string },
): Promise<GenesisCheck> {
  if (op.type !== 'plc_operation' || op.prev !== null || typeof op.sig !== 'string') return { ok: false, reason: 'NotGenesis' };
  if (didForSignedOperation(op) !== did) return { ok: false, reason: 'DidMismatch' };

  const rotationKeys = op.rotationKeys;
  if (!Array.isArray(rotationKeys) || rotationKeys.length !== 1 || typeof rotationKeys[0] !== 'string'
    || !rotationKeys[0].startsWith('did:key:zQ3s')) {
    return { ok: false, reason: 'BadRotationKeys' };
  }
  const ownerKey = rotationKeys[0];

  const { sig, ...unsigned } = op;
  let sigOk = false;
  try { sigOk = await verifySignature(ownerKey, encodeDagCbor(unsigned), base64UrlDecode(sig as string)); } catch { sigOk = false; }
  if (!sigOk) return { ok: false, reason: 'BadSignature' };

  const services = op.services as Record<string, { endpoint?: string }> | undefined;
  if (services?.atproto_pds?.endpoint !== expect.serviceUrl) return { ok: false, reason: 'WrongService' };

  const aka = Array.isArray(op.alsoKnownAs) ? (op.alsoKnownAs as string[]) : [];
  const handles = aka.filter((a) => a.startsWith('at://')).map((a) => a.slice(5));
  if (handles.length !== 1 || !handles[0].endsWith(expect.handleSuffix)
    || !/^[a-z0-9-]+$/.test(handles[0].slice(0, -expect.handleSuffix.length))) {
    return { ok: false, reason: 'BadHandle' };
  }
  const urns = aka.filter((a) => a.startsWith('urn:openfederation:pseudonym-commitment:'));
  if (urns.length !== 1 || commitmentsIn(urns).length !== 1) return { ok: false, reason: 'BadCommitment' };

  const signingKey = (op.verificationMethods as Record<string, string> | undefined)?.atproto;
  if (typeof signingKey !== 'string') return { ok: false, reason: 'NoSigningKey' };
  return { ok: true, handle: handles[0], ownerKey, signingKey };
}
