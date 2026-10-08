/**
 * Offline verifier for pseudonym reveal bundles and presence proofs. All
 * evidence travels inside the bundle; online mode additionally confirms the
 * owner's signing key against PLC.
 */
import { verifySignature } from '@atproto/crypto';
import { didForSignedOperation, encodeDagCbor, resolveFromPlc, getPlcLog } from '../plc-client.js';
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

export interface VerifyResult {
  valid: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  /** Whether owner.signingKey was confirmed to be owner.did's current key. Offline: always 'unchecked'. */
  ownerKeyBound: 'confirmed' | 'unchecked' | 'failed';
}

export interface VerifyOptions {
  online?: boolean;
  /** PLC directory base URL for the online lookup (no global config is touched). */
  plcUrl?: string;
  /** Injected DID document resolver (tests). Takes precedence over plcUrl. */
  resolveDoc?: (did: string) => Promise<Record<string, unknown> | null>;
}

async function resolveDoc(did: string, opts: VerifyOptions): Promise<Record<string, unknown> | null> {
  if (opts.resolveDoc) return opts.resolveDoc(did);
  if (opts.plcUrl) {
    const r = await fetch(`${opts.plcUrl.replace(/\/+$/, '')}/${encodeURIComponent(did)}`, { headers: { Accept: 'application/json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`PLC lookup failed (${r.status})`);
    return (await r.json()) as Record<string, unknown>;
  }
  return resolveFromPlc(did);
}

/** Fetch a pseudonym's genesis (first) PLC operation. Throws on lookup failure. */
export async function fetchGenesisOp(
  did: string,
  opts: { plcUrl?: string; getLog?: (did: string) => Promise<Record<string, unknown>[] | null> } = {},
): Promise<Record<string, unknown> | null> {
  let log: Record<string, unknown>[] | null;
  if (opts.getLog) log = await opts.getLog(did);
  else if (opts.plcUrl) {
    const r = await fetch(`${opts.plcUrl.replace(/\/+$/, '')}/${encodeURIComponent(did)}/log`, { headers: { Accept: 'application/json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`PLC log lookup failed (${r.status})`);
    log = (await r.json()) as Record<string, unknown>[];
  } else log = await getPlcLog(did);
  return Array.isArray(log) && log.length > 0 ? log[0] : null;
}

const FAIL_DETAIL: Record<string, string> = {
  genesisHash: 'genesis operation does not hash to the pseudonym DID',
  genesisSignature: 'genesis operation is not signed by its own rotation key',
  pseudonymSignature: 'pseudonym key did not sign this statement',
  commitment: 'genesis does not commit to this owner DID with this salt',
  ownerSignature: 'owner key did not sign this statement',
};

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

export async function verifyRevealBundle(bundle: unknown, opts: VerifyOptions = {}): Promise<VerifyResult> {
  try {
    return await verifyInner(bundle, opts);
  } catch (err) {
    return { valid: false, ownerKeyBound: 'unchecked', checks: [{ name: 'format', ok: false, detail: `Unverifiable bundle: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}

async function verifyInner(bundle: unknown, opts: VerifyOptions): Promise<VerifyResult> {
  if (!isBundle(bundle)) return { valid: false, ownerKeyBound: 'unchecked', checks: [{ name: 'format', ok: false, detail: 'Not a version 1 reveal bundle' }] };
  const checks: VerifyResult['checks'] = [];
  const op = bundle.pseudonym.genesisOp;
  const rotationKey = Array.isArray(op.rotationKeys) ? op.rotationKeys[0] : undefined;

  const parsed = parseLinkStatement(bundle.statement);
  checks.push({ name: 'statement', ok: !!parsed && parsed.pseudonymDid === bundle.pseudonym.did && parsed.ownerDid === bundle.owner.did,
    detail: 'statement does not match the pseudonym and owner DIDs' });

  let hashOk = false;
  try { hashOk = op.prev === null && didForSignedOperation(op) === bundle.pseudonym.did; } catch { hashOk = false; }
  checks.push({ name: 'genesisHash', ok: hashOk });

  let genesisSigOk = false;
  try {
    const { sig: genesisSig, ...unsigned } = op;
    genesisSigOk = await sigOk(rotationKey, encodeDagCbor(unsigned), genesisSig);
  } catch { genesisSigOk = false; }
  checks.push({ name: 'genesisSignature', ok: genesisSigOk });
  checks.push({ name: 'pseudonymSignature', ok: await sigOk(rotationKey, utf8(bundle.statement), bundle.pseudonym.sig) });

  let commitOk = false;
  try {
    const aka = Array.isArray(op.alsoKnownAs) ? (op.alsoKnownAs as string[]) : [];
    commitOk = commitmentsIn(aka).includes(computeCommitment(bundle.owner.did, bundle.commitmentSalt));
  } catch { commitOk = false; }
  checks.push({ name: 'commitment', ok: commitOk });

  checks.push({ name: 'ownerSignature', ok: await sigOk(bundle.owner.signingKey, utf8(bundle.statement), bundle.owner.sig) });

  let ownerKeyBound: VerifyResult['ownerKeyBound'] = 'unchecked';
  if (opts.online) {
    let current = false;
    try {
      const doc = await resolveDoc(bundle.owner.did, opts) as { verificationMethod?: { id: string; publicKeyMultibase?: string }[] } | null;
      const vm = doc?.verificationMethod?.find((v) => v.id.endsWith('#atproto'));
      current = !!vm?.publicKeyMultibase && `did:key:${vm.publicKeyMultibase}` === bundle.owner.signingKey;
    } catch { current = false; }
    checks.push({ name: 'ownerKeyCurrent', ok: current, detail: current ? undefined : 'owner signing key is not the DID\'s current #atproto key (or lookup failed)' });
    ownerKeyBound = current ? 'confirmed' : 'failed';
  }
  for (const c of checks) if (!c.ok && !c.detail) c.detail = FAIL_DETAIL[c.name];
  return { valid: checks.every((c) => c.ok), checks, ownerKeyBound };
}

/**
 * Presence proof: the signature must verify under the rotation key in the
 * pseudonym's own genesis operation, which in turn must hash to the DID.
 * Never throws.
 */
export async function verifyPresence(p: {
  pseudonymDid: string; genesisOp: Record<string, unknown>; challenge: string; signature: string;
}): Promise<boolean> {
  try {
    const op = p.genesisOp;
    if (!op || typeof op !== 'object' || op.prev !== null) return false;
    if (didForSignedOperation(op) !== p.pseudonymDid) return false;
    const key = Array.isArray(op.rotationKeys) ? op.rotationKeys[0] : undefined;
    return await sigOk(key, utf8(buildPresenceMessage({ pseudonymDid: p.pseudonymDid, challenge: p.challenge })), p.signature);
  } catch {
    return false;
  }
}
