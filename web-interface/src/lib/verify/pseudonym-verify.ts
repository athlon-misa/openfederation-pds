/**
 * Copy of packages/openfederation-pseudonym/src/verify.ts below the "shared"
 * line (tests/unit/pseudonym-public-verify.test.ts fails if they differ).
 * The dashboard builds from web-interface/ alone and depends on the published
 * @open-federation/pseudonym, which doesn't export the verifier yet; once a
 * release does, import from it and delete this file.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as dagCbor from '@ipld/dag-cbor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import bs58 from 'bs58';
import {
  parseLinkStatement, buildLinkStatement, computeCommitment, commitmentsIn, buildPresenceMessage, base64UrlDecode, base64UrlEncode,
  didForSignedOp, type SignedPlcGenesisOp,
} from '@open-federation/pseudonym';

/** As in the package's client.ts. */
type OwnerSignature =
  | { format: 'raw'; sig: string }
  | { format: 'webauthn'; authenticatorData: string; clientDataJSON: string; signature: string; credentialId?: string };
interface RevealBundleV1 {
  version: 1; statement: string;
  pseudonym: { did: string; sig: string; genesisOp: SignedPlcGenesisOp };
  owner: { did: string; sig: string; signingKey: string };
  commitmentSalt: string;
}
export interface RevealBundleV2 {
  version: 2; statement: string;
  pseudonym: { did: string; sig: string; genesisOp: SignedPlcGenesisOp };
  owner: { did: string; keyRef: 'openfederation_owner' | 'atproto'; signingKey: string; signature: OwnerSignature };
  commitmentSalt: string;
}
type RevealBundle = RevealBundleV1 | RevealBundleV2;

// ---------------------------------------------------------------- shared ----

export interface RevealVerdict {
  valid: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  /** Whether owner.signingKey was confirmed to be owner.did's current key. Offline: always 'unchecked'. */
  ownerKeyBound: 'confirmed' | 'unchecked' | 'failed';
  /** Which key the owner side claims (v1 bundles: always atproto). */
  ownerKeyRef?: 'openfederation_owner' | 'atproto';
  /**
   * What the owner signature proves, once confirmed online: `person` (the
   * person's own key, in their DID document as openfederation_owner) or
   * `pds-held-key` (the repo key their PDS holds). Otherwise `unchecked`.
   */
  ownerAttestation?: 'person' | 'pds-held-key' | 'unchecked';
}

export interface RevealVerifyOptions {
  /** Confirm the owner's key in their DID document. Needs `plcUrl` or `resolveDoc`. */
  online?: boolean;
  /** PLC directory base URL, e.g. https://plc.openfederation.net. */
  plcUrl?: string;
  /** Injected DID document resolver (tests). Takes precedence over plcUrl. */
  resolveDoc?: (did: string) => Promise<Record<string, unknown> | null>;
}

const PLC_DID = /^did:plc:[a-z2-7]{24}$/;
/** Drops trailing slashes; a loop, not a regex, so a long run of '/' stays cheap. */
const trimSlash = (u: string) => {
  let end = u.length;
  while (end > 0 && u.charCodeAt(end - 1) === 47) end--;
  return u.slice(0, end);
};

/** The did:key for a secp256k1 or P-256 public key (33-byte compressed). */
function didKeyOf(prefix: [number, number], compressed: Uint8Array): string {
  const bytes = new Uint8Array(2 + compressed.length);
  bytes.set(prefix);
  bytes.set(compressed, 2);
  return `did:key:z${bs58.encode(bytes)}`;
}

/** A did:key as a curve and a public key. Only secp256k1 and P-256. */
function parseVerifyKey(didKey: string): { curve: 'secp256k1' | 'p256'; publicKey: Uint8Array } {
  if (!didKey.startsWith('did:key:z')) throw new Error('not a did:key');
  const bytes = bs58.decode(didKey.slice('did:key:z'.length));
  if (bytes[0] === 0xe7 && bytes[1] === 0x01) return { curve: 'secp256k1', publicKey: bytes.slice(2) };
  if (bytes[0] === 0x80 && bytes[1] === 0x24) return { curve: 'p256', publicKey: bytes.slice(2) };
  throw new Error('key must be secp256k1 or P-256');
}

/**
 * A DID document's publicKeyMultibase as a did:key. Current PLC directories
 * emit Multikey (the did:key suffix); older ones the legacy secp256k1 form
 * (the raw SEC1 point, no multicodec prefix).
 */
export function didKeyFromMultibase(mb: string): string | null {
  try {
    if (!mb.startsWith('z')) return null;
    const bytes = bs58.decode(mb.slice(1));
    if (bytes.length === 35 && bytes[0] === 0xe7 && bytes[1] === 0x01) return `did:key:${mb}`;
    if (bytes.length === 35 && bytes[0] === 0x80 && bytes[1] === 0x24) return `did:key:${mb}`;
    if (bytes.length === 33 || bytes.length === 65) {
      return didKeyOf([0xe7, 0x01], secp256k1.ProjectivePoint.fromHex(bytes).toRawBytes(true));
    }
  } catch { /* fall through */ }
  return null;
}

/** AT Protocol signature rule: compact 64 bytes, low-S, over sha256(data). */
function didKeySigOk(didKey: unknown, data: Uint8Array, sig: unknown): boolean {
  if (typeof didKey !== 'string' || typeof sig !== 'string') return false;
  try {
    const key = parseVerifyKey(didKey);
    const raw = base64UrlDecode(sig);
    if (raw.length !== 64) return false;
    const curve = key.curve === 'secp256k1' ? secp256k1 : p256;
    return curve.verify(raw, sha256(data), key.publicKey, { lowS: true, format: 'compact' });
  } catch {
    return false;
  }
}

/**
 * An owner signature (ADR-003, decision 7): raw (secp256k1 or P-256, low-S,
 * compact, over sha256(text)) or a passkey assertion over the text's digest.
 * Origin and rpId are not enforced.
 */
export function ownerSignatureOk(text: string, signature: OwnerSignature, ownerDidKey: string): boolean {
  try {
    const key = parseVerifyKey(ownerDidKey);
    const digest = sha256(utf8ToBytes(text));
    if (signature?.format === 'raw') {
      const sig = base64UrlDecode(signature.sig);
      if (sig.length !== 64) return false;
      return (key.curve === 'secp256k1' ? secp256k1 : p256).verify(sig, digest, key.publicKey, { lowS: true, format: 'compact' });
    }
    if (signature?.format === 'webauthn') {
      if (key.curve !== 'p256') return false;
      const authData = base64UrlDecode(signature.authenticatorData);
      const clientDataBytes = base64UrlDecode(signature.clientDataJSON);
      const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes)) as { type?: string; challenge?: string };
      if (clientData.type !== 'webauthn.get' || clientData.challenge !== base64UrlEncode(digest)) return false;
      if (authData.length < 37 || (authData[32] & 0x01) === 0) return false;
      const signed = new Uint8Array(authData.length + 32);
      signed.set(authData);
      signed.set(sha256(clientDataBytes), authData.length);
      return p256.verify(base64UrlDecode(signature.signature), sha256(signed), key.publicKey, { format: 'der', lowS: false });
    }
    return false;
  } catch {
    return false;
  }
}

/** The genesis rotation key, under the server's rule: exactly one secp256k1 did:key. */
function genesisRotationKey(op: Record<string, unknown>): string | undefined {
  const keys = op.rotationKeys;
  if (!Array.isArray(keys) || keys.length !== 1 || typeof keys[0] !== 'string' || !keys[0].startsWith('did:key:zQ3s')) return undefined;
  return keys[0];
}

/** The single commitment in the genesis op (exactly one well-formed URN), else undefined. */
function genesisCommitment(op: Record<string, unknown>): string | undefined {
  const aka = Array.isArray(op.alsoKnownAs) ? (op.alsoKnownAs as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  const urns = aka.filter((a) => a.startsWith('urn:openfederation:pseudonym-commitment:'));
  const valid = commitmentsIn(urns);
  return urns.length === 1 && valid.length === 1 ? valid[0] : undefined;
}

/** Does this signed operation hash to `did`, as a genesis operation? */
function genesisHashOk(op: Record<string, unknown>, did: string): boolean {
  try { return op.prev === null && didForSignedOp(op as unknown as SignedPlcGenesisOp) === did; } catch { return false; }
}

function genesisSignatureOk(op: Record<string, unknown>): boolean {
  try {
    const { sig, ...unsigned } = op;
    return didKeySigOk(genesisRotationKey(op), dagCbor.encode(unsigned), sig);
  } catch {
    return false;
  }
}

/** A pseudonym's genesis (first) operation from the PLC directory, or null if the DID is unknown. */
export async function fetchGenesisOp(did: string, opts: { plcUrl: string }): Promise<Record<string, unknown> | null> {
  if (!PLC_DID.test(did)) throw new Error('Not a did:plc');
  const r = await fetch(`${trimSlash(opts.plcUrl)}/${did}/log`, { headers: { Accept: 'application/json' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`PLC log lookup failed (${r.status})`);
  const log = (await r.json()) as Record<string, unknown>[];
  return Array.isArray(log) && log.length > 0 ? log[0] : null;
}

async function resolveDidDoc(did: string, opts: RevealVerifyOptions): Promise<Record<string, unknown> | null> {
  if (opts.resolveDoc) return opts.resolveDoc(did);
  if (!opts.plcUrl) throw new Error('plcUrl is required to verify online');
  if (!PLC_DID.test(did)) throw new Error('Not a did:plc');
  const r = await fetch(`${trimSlash(opts.plcUrl)}/${did}`, { headers: { Accept: 'application/json' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`PLC lookup failed (${r.status})`);
  return (await r.json()) as Record<string, unknown>;
}

/** The did:key a DID document names under `#<name>`, if any. */
export function didDocKey(doc: Record<string, unknown> | null, name: string): string | null {
  const vms = (doc as { verificationMethod?: { id?: string; publicKeyMultibase?: string }[] } | null)?.verificationMethod;
  const vm = Array.isArray(vms) ? vms.find((v) => typeof v?.id === 'string' && v.id.endsWith(`#${name}`)) : undefined;
  return vm?.publicKeyMultibase ? didKeyFromMultibase(vm.publicKeyMultibase) : null;
}

const FAIL_DETAIL: Record<string, string> = {
  genesisHash: 'genesis operation does not hash to the pseudonym DID',
  genesisSignature: 'genesis operation does not have exactly one rotation key, or is not signed by it',
  pseudonymSignature: 'pseudonym key did not sign this statement',
  commitment: 'genesis does not carry exactly one commitment, committing to this owner DID with this salt',
  ownerSignature: 'owner key did not sign this statement',
};

function isBundle(b: any): b is RevealBundle {
  const common = !!b && typeof b.statement === 'string' && typeof b.commitmentSalt === 'string'
    && !!b.pseudonym && typeof b.pseudonym.did === 'string' && typeof b.pseudonym.sig === 'string'
    && !!b.pseudonym.genesisOp && typeof b.pseudonym.genesisOp === 'object'
    && !!b.owner && typeof b.owner.did === 'string' && typeof b.owner.signingKey === 'string';
  if (!common) return false;
  if (b.version === 1) return typeof b.owner.sig === 'string';
  if (b.version === 2) {
    return (b.owner.keyRef === 'openfederation_owner' || b.owner.keyRef === 'atproto')
      && !!b.owner.signature && typeof b.owner.signature === 'object' && typeof b.owner.signature.format === 'string';
  }
  return false;
}

/**
 * Check a reveal bundle. Offline, everything inside it; online, also that
 * the owner key is the owner DID's current key under the name the bundle
 * gives (`openfederation_owner`: the person; `atproto`: their PDS-held key).
 * Never throws.
 */
export async function verifyRevealBundle(bundle: unknown, opts: RevealVerifyOptions = {}): Promise<RevealVerdict> {
  try {
    return await verifyRevealInner(bundle, opts);
  } catch (err) {
    return { valid: false, ownerKeyBound: 'unchecked', checks: [{ name: 'format', ok: false, detail: `Unverifiable bundle: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}

async function verifyRevealInner(bundle: unknown, opts: RevealVerifyOptions): Promise<RevealVerdict> {
  if (!isBundle(bundle)) return { valid: false, ownerKeyBound: 'unchecked', checks: [{ name: 'format', ok: false, detail: 'Not a version 1 or 2 reveal bundle' }] };
  const keyRef = bundle.version === 2 ? bundle.owner.keyRef : 'atproto';
  const checks: RevealVerdict['checks'] = [];
  const op = bundle.pseudonym.genesisOp as unknown as Record<string, unknown>;
  const rotationKey = genesisRotationKey(op);
  const text = utf8ToBytes(bundle.statement);

  const parsed = parseLinkStatement(bundle.statement);
  checks.push({ name: 'statement', ok: !!parsed && parsed.pseudonymDid === bundle.pseudonym.did && parsed.ownerDid === bundle.owner.did,
    detail: 'statement does not match the pseudonym and owner DIDs' });
  checks.push({ name: 'genesisHash', ok: genesisHashOk(op, bundle.pseudonym.did) });
  checks.push({ name: 'genesisSignature', ok: genesisSignatureOk(op) });
  checks.push({ name: 'pseudonymSignature', ok: didKeySigOk(rotationKey, text, bundle.pseudonym.sig) });

  let commitOk = false;
  try {
    const commitment = genesisCommitment(op);
    commitOk = !!commitment && commitment === computeCommitment(bundle.owner.did, bundle.commitmentSalt);
  } catch { commitOk = false; }
  checks.push({ name: 'commitment', ok: commitOk });

  checks.push({ name: 'ownerSignature', ok: bundle.version === 2
    ? ownerSignatureOk(bundle.statement, bundle.owner.signature, bundle.owner.signingKey)
    : didKeySigOk(bundle.owner.signingKey, text, bundle.owner.sig) });

  let ownerKeyBound: RevealVerdict['ownerKeyBound'] = 'unchecked';
  if (opts.online) {
    let current = false;
    try {
      current = didDocKey(await resolveDidDoc(bundle.owner.did, opts), keyRef) === bundle.owner.signingKey;
    } catch { current = false; }
    checks.push({ name: 'ownerKeyCurrent', ok: current, detail: current ? undefined : `owner signing key is not the DID's current #${keyRef} key (or lookup failed)` });
    ownerKeyBound = current ? 'confirmed' : 'failed';
  }
  for (const c of checks) if (!c.ok && !c.detail) c.detail = FAIL_DETAIL[c.name];
  const valid = checks.every((c) => c.ok);
  const ownerAttestation: RevealVerdict['ownerAttestation'] = valid && ownerKeyBound === 'confirmed'
    ? (keyRef === 'openfederation_owner' ? 'person' : 'pds-held-key')
    : 'unchecked';
  return { valid, checks, ownerKeyBound, ownerKeyRef: keyRef, ownerAttestation };
}

/**
 * Presence proof: the signature must verify under the rotation key in the
 * pseudonym's own genesis operation, which must hash to the DID and be
 * pseudonym-shaped (one rotation key, one commitment). Never throws.
 */
export function verifyPresence(p: { pseudonymDid: string; genesisOp: Record<string, unknown>; challenge: string; signature: string }): boolean {
  try {
    const op = p.genesisOp;
    if (!op || typeof op !== 'object' || !genesisHashOk(op, p.pseudonymDid)) return false;
    const key = genesisRotationKey(op);
    if (!key || !genesisCommitment(op)) return false;
    return didKeySigOk(key, utf8ToBytes(buildPresenceMessage({ pseudonymDid: p.pseudonymDid, challenge: p.challenge })), p.signature);
  } catch {
    return false;
  }
}

/** A presence proof checked online: the key comes from the PLC directory. Never throws. */
export async function checkPresence(p: { plcUrl: string; pseudonymDid: string; challenge: string; signature: string }): Promise<{ valid: boolean; directoryKey?: string; error?: string }> {
  try {
    const genesisOp = await fetchGenesisOp(p.pseudonymDid, { plcUrl: p.plcUrl });
    if (!genesisOp) return { valid: false, error: 'Not found in the directory' };
    return { valid: verifyPresence({ ...p, genesisOp }), directoryKey: genesisRotationKey(genesisOp) };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A spoken word as a 64-hex presence challenge: sha256 of `context`, a
 * newline and the word (trimmed, lower case). The signer and every verifier
 * must use the same context, e.g. "OpenNewsrooms stage challenge".
 */
export function challengeForWord(word: string, context: string): string {
  return bytesToHex(sha256(utf8ToBytes(`${context}\n${word.trim().toLowerCase()}`)));
}

// ---- Links: a reveal or a presence proof in a URL fragment ----

/** What a verifier link carries. Fragments never reach a server log. */
export type VerifyLink =
  | { kind: 'presence'; pseudonymDid: string; word: string; signature: string }
  | {
    kind: 'reveal'; pseudonymDid: string; ownerDid: string; issuedAt: string;
    keyRef: 'openfederation_owner' | 'atproto'; pseudonymSig: string; ownerSig: string; commitmentSalt: string;
  };

const plcSuffix = (did: string) => {
  if (!PLC_DID.test(did)) throw new Error('Not a did:plc');
  return did.slice('did:plc:'.length);
};
const plcDid = (suffix: string | null) => {
  const did = `did:plc:${suffix ?? ''}`;
  if (!PLC_DID.test(did)) throw new Error('Not a did:plc');
  return did;
};

/**
 * A fragment (without `#`) for a reveal bundle, short enough for a QR code:
 * DIDs without `did:plc:`, the time in milliseconds, the salt in base64url.
 * The genesis operation and the owner's key are left out: the verifier reads
 * both from the PLC directory. Raw owner signatures only (not passkeys).
 */
export function revealLinkFragment(bundle: RevealBundleV2): string {
  if (bundle.owner.signature.format !== 'raw') throw new Error('Only raw owner signatures fit in a link');
  const parsed = parseLinkStatement(bundle.statement);
  if (!parsed) throw new Error('Not a canonical link statement');
  const salt = base64UrlEncode(Uint8Array.from(bundle.commitmentSalt.match(/../g) ?? [], (h) => parseInt(h, 16)));
  return new URLSearchParams({
    r: '2', p: plcSuffix(parsed.pseudonymDid), o: plcSuffix(parsed.ownerDid), t: String(Date.parse(parsed.issuedAt)),
    k: bundle.owner.keyRef === 'openfederation_owner' ? 'o' : 'a', ps: bundle.pseudonym.sig, os: bundle.owner.signature.sig, s: salt,
  }).toString();
}

/** A fragment (without `#`) for a presence proof: the pseudonym, the word and the signature. */
export function presenceLinkFragment(p: { pseudonymDid: string; word: string; signature: string }): string {
  return new URLSearchParams({ w: p.word.trim(), d: plcSuffix(p.pseudonymDid), s: p.signature }).toString();
}

/** Read a verifier link's fragment (with or without `#`). Throws on anything malformed. */
export function parseVerifyLink(fragment: string): VerifyLink {
  const q = new URLSearchParams(fragment.replace(/^#/, ''));
  if (q.get('r') === '2') {
    const t = Number(q.get('t'));
    const keyRef = q.get('k') === 'o' ? 'openfederation_owner' : q.get('k') === 'a' ? 'atproto' : null;
    const salt = base64UrlDecode(q.get('s') ?? '');
    if (!Number.isSafeInteger(t) || !keyRef || salt.length !== 32 || !q.get('ps') || !q.get('os')) throw new Error('Not a reveal link');
    return {
      kind: 'reveal', pseudonymDid: plcDid(q.get('p')), ownerDid: plcDid(q.get('o')), issuedAt: new Date(t).toISOString(),
      keyRef, pseudonymSig: q.get('ps')!, ownerSig: q.get('os')!, commitmentSalt: bytesToHex(salt),
    };
  }
  if (q.has('w') && q.has('d') && q.has('s')) {
    const word = q.get('w')!.trim();
    if (!word) throw new Error('Not a presence link');
    return { kind: 'presence', pseudonymDid: plcDid(q.get('d')), word, signature: q.get('s')! };
  }
  throw new Error('Not a verifier link');
}

/**
 * Rebuild the full reveal bundle from a link: the statement from its parts,
 * the genesis operation from the directory, and the owner key the DID
 * document names under the link's key name (empty when it names none, which
 * then fails the owner checks). Check the result online.
 */
export async function revealBundleFromLink(link: Extract<VerifyLink, { kind: 'reveal' }>, opts: { plcUrl: string }): Promise<RevealBundleV2> {
  const genesisOp = await fetchGenesisOp(link.pseudonymDid, opts);
  if (!genesisOp) throw new Error('The pseudonym is not in the directory');
  const signingKey = didDocKey(await resolveDidDoc(link.ownerDid, opts), link.keyRef) ?? '';
  return {
    version: 2,
    statement: buildLinkStatement({ pseudonymDid: link.pseudonymDid, ownerDid: link.ownerDid, issuedAt: link.issuedAt }),
    commitmentSalt: link.commitmentSalt,
    pseudonym: { did: link.pseudonymDid, sig: link.pseudonymSig, genesisOp: genesisOp as unknown as SignedPlcGenesisOp },
    owner: { did: link.ownerDid, keyRef: link.keyRef, signingKey, signature: { format: 'raw', sig: link.ownerSig } },
  };
}

/** The handle a DID document names (its first at:// alias), if any. */
export function handleFromDoc(doc: Record<string, unknown> | null): string | undefined {
  const aka = (doc as { alsoKnownAs?: unknown[] } | null)?.alsoKnownAs;
  const at = Array.isArray(aka) ? aka.find((a): a is string => typeof a === 'string' && a.startsWith('at://')) : undefined;
  return at?.slice('at://'.length);
}

/** What a verifier page shows for a link: the verdict, and who, by handle as the directory names them. */
export type LinkVerdict =
  | { kind: 'presence'; valid: boolean; pseudonymDid: string; pseudonymHandle?: string; word: string; directoryKey?: string; error?: string }
  | {
    kind: 'reveal'; valid: boolean; pseudonymDid: string; pseudonymHandle?: string; ownerDid: string; ownerHandle?: string;
    ownerAttestation: RevealVerdict['ownerAttestation']; checks: RevealVerdict['checks']; error?: string;
  };

/**
 * Check a verifier link against the PLC directory, as a phone does: the
 * presence proof with the key in the pseudonym's genesis operation, or the
 * reveal with both DIDs resolved. `presenceContext` is the context the
 * signer turned the word into a challenge with (see challengeForWord).
 * Throws only on a malformed link.
 */
export async function verifyLink(fragment: string, opts: { plcUrl: string; presenceContext: string }): Promise<LinkVerdict> {
  const link = parseVerifyLink(fragment);
  const handle = (did: string) => resolveDidDoc(did, opts).then(handleFromDoc, () => undefined);
  if (link.kind === 'presence') {
    const [r, pseudonymHandle] = await Promise.all([
      checkPresence({ plcUrl: opts.plcUrl, pseudonymDid: link.pseudonymDid, challenge: challengeForWord(link.word, opts.presenceContext), signature: link.signature }),
      handle(link.pseudonymDid),
    ]);
    return { kind: 'presence', pseudonymDid: link.pseudonymDid, pseudonymHandle, word: link.word, ...r };
  }
  const base = { kind: 'reveal' as const, pseudonymDid: link.pseudonymDid, ownerDid: link.ownerDid };
  const [pseudonymHandle, ownerHandle] = await Promise.all([handle(link.pseudonymDid), handle(link.ownerDid)]);
  let bundle: RevealBundleV2;
  try {
    bundle = await revealBundleFromLink(link, opts);
  } catch (err) {
    return { ...base, pseudonymHandle, ownerHandle, valid: false, ownerAttestation: 'unchecked', checks: [], error: err instanceof Error ? err.message : String(err) };
  }
  const r = await verifyRevealBundle(bundle, { online: true, plcUrl: opts.plcUrl });
  return { ...base, pseudonymHandle, ownerHandle, valid: r.valid, ownerAttestation: r.ownerAttestation, checks: r.checks };
}
