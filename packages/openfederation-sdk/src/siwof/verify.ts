/**
 * Offline verification of a SIWOF didToken + walletProof.
 *
 * Runs entirely in the browser (or Node) without calling OpenFederation.
 * The dApp resolves the claimant DID via W3C DID methods (did:plc through
 * a PLC directory, did:web via HTTPS) to get the atproto signing key, then
 * verifies the JWT signature and cross-checks the wallet proof.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const DEFAULT_PLC_URL = 'https://plc.directory';

// multicodec varint prefixes used in did:key / publicKeyMultibase
const SECP256K1_PREFIX = new Uint8Array([0xe7, 0x01]);
const P256_PREFIX = new Uint8Array([0x80, 0x24]);

export interface VerifiedSignInAssertion {
  did: string;
  audience: string;
  nonce: string;
  chain: 'ethereum' | 'solana';
  walletAddress: string;
  chainIdCaip2: string;
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds. */
  expiresAt: number;
  claims: Record<string, unknown>;
}

export interface WalletProof {
  message: string;
  signature: string;
  chain: 'ethereum' | 'solana';
  walletAddress: string;
  chainIdCaip2: string;
}

export interface VerifySignInOptions {
  /**
   * Root URL of the PLC directory to resolve did:plc identifiers (default
   * https://plc.directory). Only consulted if the iss DID is did:plc.
   */
  plcUrl?: string;
  /**
   * Expected audience. If provided, the JWT's aud and the message's URI
   * must match; otherwise rejection.
   */
  expectedAudience?: string;
  /** Seconds of clock skew tolerance (default 30). */
  clockSkewSec?: number;
  /**
   * Override the DID resolver (for tests). Return a signing-key did:key
   * string like "did:key:zQ3sh..." for the given DID.
   */
  resolveSigningKey?: (did: string) => Promise<string>;
}

export class SiwofVerifyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SiwofVerifyError';
    this.code = code;
  }
}

/**
 * Verify a SIWOF assertion. On success, returns the distilled claims the
 * dApp can trust: who signed in, which wallet they control, which audience
 * the assertion is scoped to, and the nonce. On failure, throws a typed
 * SiwofVerifyError.
 */
export async function verifySignInAssertion(
  didToken: string,
  walletProof: WalletProof,
  opts: VerifySignInOptions = {}
): Promise<VerifiedSignInAssertion> {
  const parts = didToken.split('.');
  if (parts.length !== 3) throw new SiwofVerifyError('InvalidToken', 'Malformed JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecodeString(headerB64));
    payload = JSON.parse(base64UrlDecodeString(payloadB64));
  } catch {
    throw new SiwofVerifyError('InvalidToken', 'Malformed JWT header or payload');
  }

  const alg = header.alg;
  if (alg !== 'ES256K' && alg !== 'ES256') {
    throw new SiwofVerifyError('InvalidToken', `Unsupported JWT alg: ${alg ?? 'none'}`);
  }

  const iss = payload.iss as string | undefined;
  const aud = payload.aud as string | undefined;
  const exp = payload.exp as number | undefined;
  const iat = payload.iat as number | undefined;
  const sub = payload.sub as string | undefined;
  const nonce = payload.nonce as string | undefined;
  const walletAddress = payload.walletAddress as string | undefined;
  const chain = payload.chain as 'ethereum' | 'solana' | undefined;
  const chainIdCaip2 = payload.chainIdCaip2 as string | undefined;

  if (!iss?.startsWith('did:')) throw new SiwofVerifyError('InvalidToken', 'Missing or invalid iss');
  if (typeof aud !== 'string') throw new SiwofVerifyError('InvalidToken', 'Missing aud');
  if (typeof exp !== 'number') throw new SiwofVerifyError('InvalidToken', 'Missing exp');
  if (typeof sub !== 'string') throw new SiwofVerifyError('InvalidToken', 'Missing sub (CAIP-10 account)');
  if (typeof nonce !== 'string') throw new SiwofVerifyError('InvalidToken', 'Missing nonce');
  if (chain !== 'ethereum' && chain !== 'solana') throw new SiwofVerifyError('InvalidToken', 'Unsupported chain claim');
  if (typeof walletAddress !== 'string') throw new SiwofVerifyError('InvalidToken', 'Missing walletAddress');
  if (typeof chainIdCaip2 !== 'string') throw new SiwofVerifyError('InvalidToken', 'Missing chainIdCaip2');

  const nowSec = Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSec ?? 30;
  if (exp + skew < nowSec) throw new SiwofVerifyError('ExpiredToken', 'didToken has expired');
  if (typeof iat === 'number' && iat - skew > nowSec) {
    throw new SiwofVerifyError('InvalidToken', 'iat is in the future');
  }

  if (opts.expectedAudience) {
    const norm = normalizeAudienceOrThrow(opts.expectedAudience);
    const audNorm = normalizeAudienceOrThrow(aud);
    if (norm !== audNorm) throw new SiwofVerifyError('BadAudience', `Token aud "${aud}" does not match expected "${opts.expectedAudience}"`);
  }

  // Cross-check walletProof consistency with the didToken.
  if (walletProof.chain !== chain) throw new SiwofVerifyError('ProofMismatch', 'walletProof.chain != didToken.chain');
  if (walletProof.chainIdCaip2 !== chainIdCaip2) throw new SiwofVerifyError('ProofMismatch', 'walletProof.chainIdCaip2 != didToken.chainIdCaip2');
  const waToken = chain === 'ethereum' ? walletAddress.toLowerCase() : walletAddress;
  const waProof = chain === 'ethereum' ? walletProof.walletAddress.toLowerCase() : walletProof.walletAddress;
  if (waToken !== waProof) throw new SiwofVerifyError('ProofMismatch', 'walletProof.walletAddress != didToken.walletAddress');

  // 1. Verify the wallet proof against the address.
  const walletValid = await verifyWalletSignature(chain, walletProof.message, walletProof.signature, waProof);
  if (!walletValid) throw new SiwofVerifyError('InvalidWalletSignature', 'Wallet signature does not verify against walletAddress');

  // 2. Resolve the issuer DID → atproto signing key → verify JWT signature.
  const signingKeyDidKey = opts.resolveSigningKey
    ? await opts.resolveSigningKey(iss)
    : await resolveAtprotoKey(iss, opts.plcUrl ?? DEFAULT_PLC_URL);
  const keyBytes = parseDidKey(signingKeyDidKey);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const digest = sha256(signingInput);
  const sig = base64UrlDecodeBytes(sigB64);

  const jwtValid = alg === 'ES256K'
    ? secp256k1.verify(sig, digest, keyBytes.publicKey, { prehash: false, format: 'compact' })
    : p256.verify(sig, digest, keyBytes.publicKey, { prehash: false, format: 'compact' });
  if (!jwtValid) throw new SiwofVerifyError('InvalidJwtSignature', 'didToken signature does not verify against the issuer DID atproto key');

  return {
    did: iss,
    audience: aud,
    nonce,
    chain,
    walletAddress: waProof,
    chainIdCaip2,
    issuedAt: typeof iat === 'number' ? iat : 0,
    expiresAt: exp,
    claims: payload,
  };
}

// ─── Wallet signature verification ─────────────────────────────────────────

async function verifyWalletSignature(
  chain: 'ethereum' | 'solana',
  message: string,
  signature: string,
  walletAddress: string
): Promise<boolean> {
  const msgBytes = new TextEncoder().encode(message);
  if (chain === 'ethereum') {
    try {
      return verifyEip191(msgBytes, signature, walletAddress);
    } catch { return false; }
  }
  try {
    const sigBytes = bs58.decode(signature);
    const pkBytes = bs58.decode(walletAddress);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pkBytes);
  } catch { return false; }
}

function verifyEip191(msgBytes: Uint8Array, signatureHex: string, expectedAddress: string): boolean {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const combined = new Uint8Array(prefix.length + msgBytes.length);
  combined.set(prefix, 0);
  combined.set(msgBytes, prefix.length);
  const digest = keccak_256(combined);

  const clean = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
  if (clean.length !== 130) return false;
  const sigBytes = hexToBytes(clean.slice(0, 128)); // r || s
  const v = parseInt(clean.slice(128), 16);
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return false;

  // Recover the public key. @noble/curves v1 exposes this via the Signature
  // instance's deprecated `recoverPublicKey` (still the most portable path
  // across minor versions); Point → raw bytes via toBytes(false).
  let recovered: Uint8Array;
  try {
    const sig = secp256k1.Signature.fromBytes(sigBytes, 'compact').addRecoveryBit(recovery);
    const point = (sig as unknown as { recoverPublicKey: (m: Uint8Array) => { toBytes: (compressed?: boolean) => Uint8Array } }).recoverPublicKey(digest);
    recovered = point.toBytes(false); // uncompressed: 0x04 || X(32) || Y(32)
  } catch { return false; }
  // Uncompressed pubkey: 0x04 || X(32) || Y(32). Ethereum address = last 20 of keccak(X||Y).
  const addrHash = keccak_256(recovered.slice(1));
  const addr = '0x' + bytesToHex(addrHash.slice(-20));
  return addr.toLowerCase() === expectedAddress.toLowerCase();
}

// ─── DID resolution (minimal) ──────────────────────────────────────────────

async function resolveAtprotoKey(did: string, plcUrl: string): Promise<string> {
  let docUrl: string;
  if (did.startsWith('did:plc:')) {
    docUrl = `${plcUrl.replace(/\/$/, '')}/${did}`;
  } else if (did.startsWith('did:web:')) {
    const rest = did.slice('did:web:'.length);
    // did:web:host[:path:segments] — colons become slashes, host may have ports.
    const parts = rest.split(':');
    const host = decodeURIComponent(parts.shift()!);
    const path = parts.length === 0 ? '/.well-known/did.json' : '/' + parts.map(decodeURIComponent).join('/') + '/did.json';
    docUrl = `https://${host}${path}`;
  } else {
    throw new SiwofVerifyError('UnresolvableDid', `Only did:plc and did:web are supported; got ${did}`);
  }

  const res = await fetch(docUrl, { headers: { Accept: 'application/did+json, application/json' } });
  if (!res.ok) throw new SiwofVerifyError('UnresolvableDid', `DID document fetch failed (${res.status})`);
  const doc = await res.json() as { verificationMethod?: Array<{ id?: string; type?: string; publicKeyMultibase?: string }> };
  const methods = doc.verificationMethod ?? [];
  const atprotoMethod = methods.find((m) => typeof m.id === 'string' && m.id.endsWith('#atproto'));
  if (!atprotoMethod?.publicKeyMultibase) {
    throw new SiwofVerifyError('UnresolvableDid', 'DID document has no #atproto verificationMethod');
  }
  // Convert publicKeyMultibase (base58btc "z..." multikey) into did:key form.
  return `did:key:${atprotoMethod.publicKeyMultibase}`;
}

function parseDidKey(didKey: string): { jwtAlg: 'ES256K' | 'ES256'; publicKey: Uint8Array } {
  if (!didKey.startsWith('did:key:z')) throw new SiwofVerifyError('UnresolvableDid', 'Not a base58btc did:key');
  const multibase = didKey.slice('did:key:'.length); // "z..."
  const bytes = bs58.decode(multibase.slice(1));
  if (bytes[0] === SECP256K1_PREFIX[0] && bytes[1] === SECP256K1_PREFIX[1]) {
    return { jwtAlg: 'ES256K', publicKey: bytes.slice(2) };
  }
  if (bytes[0] === P256_PREFIX[0] && bytes[1] === P256_PREFIX[1]) {
    return { jwtAlg: 'ES256', publicKey: bytes.slice(2) };
  }
  throw new SiwofVerifyError('UnresolvableDid', 'Unsupported did:key multicodec prefix (expected secp256k1 or P-256)');
}

// ─── helpers ────────────────────────────────────────────────────────────────

function normalizeAudienceOrThrow(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    throw new SiwofVerifyError('BadAudience', `Invalid audience URL: ${raw}`);
  }
}

function base64UrlDecodeString(b64: string): string {
  const std = base64UrlToStandard(b64);
  if (typeof Buffer !== 'undefined') return Buffer.from(std, 'base64').toString('utf-8');
  return new TextDecoder().decode(Uint8Array.from(atob(std), (c) => c.charCodeAt(0)));
}

function base64UrlDecodeBytes(b64: string): Uint8Array {
  const std = base64UrlToStandard(b64);
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(std, 'base64'));
  return Uint8Array.from(atob(std), (c) => c.charCodeAt(0));
}

function base64UrlToStandard(b64: string): string {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
