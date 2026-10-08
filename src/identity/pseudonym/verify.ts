/**
 * Offline verifier for pseudonym reveal bundles and presence proofs. All
 * evidence travels inside the bundle; online mode additionally confirms the
 * owner's signing key against PLC.
 */
import { verifySignature } from '@atproto/crypto';
import { didForSignedOperation, encodeDagCbor, resolveFromPlc } from '../plc-client.js';
import {
  parseLinkStatement, computeCommitment, commitmentsIn, buildPresenceMessage, base64UrlDecode,
} from '../../../packages/openfederation-pseudonym/src/formats.js';

export interface RevealBundle {
  version: 1;
  statement: string;
  pseudonym: { did: string; sig: string; genesisOp: Record<string, unknown> };
  owner: { did: string; sig: string; signingKey: string };
  commitmentSalt: string;
}

export interface VerifyResult { valid: boolean; checks: { name: string; ok: boolean; detail?: string }[] }

const utf8 = (s: string) => new TextEncoder().encode(s);

async function sigOk(didKey: unknown, data: Uint8Array, sig: unknown): Promise<boolean> {
  if (typeof didKey !== 'string' || typeof sig !== 'string') return false;
  try { return await verifySignature(didKey, data, base64UrlDecode(sig)); } catch { return false; }
}

function isBundle(b: any): b is RevealBundle {
  return !!b && b.version === 1 && typeof b.statement === 'string' && typeof b.commitmentSalt === 'string'
    && !!b.pseudonym && typeof b.pseudonym.did === 'string' && typeof b.pseudonym.sig === 'string'
    && !!b.pseudonym.genesisOp && typeof b.pseudonym.genesisOp === 'object'
    && !!b.owner && typeof b.owner.did === 'string' && typeof b.owner.sig === 'string' && typeof b.owner.signingKey === 'string';
}

export async function verifyRevealBundle(bundle: unknown, opts: { online?: boolean } = {}): Promise<VerifyResult> {
  if (!isBundle(bundle)) return { valid: false, checks: [{ name: 'format', ok: false, detail: 'Not a version 1 reveal bundle' }] };
  const checks: VerifyResult['checks'] = [];
  const op = bundle.pseudonym.genesisOp;
  const rotationKey = Array.isArray(op.rotationKeys) ? op.rotationKeys[0] : undefined;

  const parsed = parseLinkStatement(bundle.statement);
  checks.push({ name: 'statement', ok: !!parsed && parsed.pseudonymDid === bundle.pseudonym.did && parsed.ownerDid === bundle.owner.did });

  let hashOk = false;
  try { hashOk = op.prev === null && didForSignedOperation(op) === bundle.pseudonym.did; } catch { hashOk = false; }
  checks.push({ name: 'genesisHash', ok: hashOk });

  const { sig: genesisSig, ...unsigned } = op;
  checks.push({ name: 'genesisSignature', ok: await sigOk(rotationKey, encodeDagCbor(unsigned), genesisSig) });
  checks.push({ name: 'pseudonymSignature', ok: await sigOk(rotationKey, utf8(bundle.statement), bundle.pseudonym.sig) });

  let commitOk = false;
  try {
    const aka = Array.isArray(op.alsoKnownAs) ? (op.alsoKnownAs as string[]) : [];
    commitOk = commitmentsIn(aka).includes(computeCommitment(bundle.owner.did, bundle.commitmentSalt));
  } catch { commitOk = false; }
  checks.push({ name: 'commitment', ok: commitOk });

  checks.push({ name: 'ownerSignature', ok: await sigOk(bundle.owner.signingKey, utf8(bundle.statement), bundle.owner.sig) });

  if (opts.online) {
    let current = false;
    try {
      const doc = await resolveFromPlc(bundle.owner.did) as { verificationMethod?: { id: string; publicKeyMultibase?: string }[] } | null;
      const vm = doc?.verificationMethod?.find((v) => v.id.endsWith('#atproto'));
      current = !!vm?.publicKeyMultibase && `did:key:${vm.publicKeyMultibase}` === bundle.owner.signingKey;
    } catch { current = false; }
    checks.push({ name: 'ownerKeyCurrent', ok: current });
  }
  return { valid: checks.every((c) => c.ok), checks };
}

export async function verifyPresence(p: { pseudonymDid: string; ownerKey: string; challenge: string; signature: string }): Promise<boolean> {
  try {
    return await sigOk(p.ownerKey, utf8(buildPresenceMessage({ pseudonymDid: p.pseudonymDid, challenge: p.challenge })), p.signature);
  } catch {
    return false;
  }
}
