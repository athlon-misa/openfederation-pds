/**
 * AT Protocol service-auth JWT verification and signing.
 *
 * Spec: https://atproto.com/specs/xrpc#service-authentication
 *
 * Inbound service-auth JWTs let a user on another PDS authenticate to this PDS
 * without holding a local session. The JWT is signed by the caller's atproto
 * signing key (resolved from their DID document) and carries:
 *   - iss: caller's DID
 *   - aud: this PDS's service DID (e.g. did:web:pds.example.com)
 *   - exp: short-lived Unix timestamp (seconds)
 *   - iat / nbf: optional freshness claims
 *   - jti:        optional nonce for replay protection
 *   - lxm:        optional NSID this token is scoped to
 *
 * We also expose a signing helper used by com.atproto.server.getServiceAuth
 * so our local users can authenticate outbound to other PDSes.
 */

import { randomBytes } from 'crypto';
import type { Keypair } from '@atproto/crypto';
import { verifySignature } from '@atproto/crypto';
import { getDidResolver } from '../identity/did-resolver.js';
import { config } from '../config.js';

export type ServiceAuthClaims = {
  iss: string;
  aud: string;
  exp: number;
  iat?: number;
  nbf?: number;
  jti?: string;
  lxm?: string;
};

export type ServiceAuthVerifyOptions = {
  /** Expected audience (service DID). If set, aud must exactly match. */
  expectedAud?: string;
  /** Expected lexicon method. If set AND the JWT has an lxm, must match. */
  expectedLxm?: string;
  /** Clock skew tolerance in seconds (default 30). */
  clockSkewSec?: number;
  /** Override DID → atproto signing-key resolution. Used by tests. */
  resolveSigningKey?: (did: string) => Promise<string>;
};

/** Typed errors so the middleware can map to specific HTTP codes. */
export class ServiceAuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = 'ServiceAuthError';
    this.code = code;
    this.status = status;
  }
}

const SUPPORTED_ALGS = new Set(['ES256K', 'ES256']);

/** Return true if the given Authorization token's header alg is a service-auth alg. */
export function looksLikeServiceAuthJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(base64UrlDecodeString(parts[0])) as { alg?: unknown };
    return typeof header.alg === 'string' && SUPPORTED_ALGS.has(header.alg);
  } catch {
    return false;
  }
}

/** The service DID this PDS accepts in the `aud` claim of inbound JWTs. */
export function getServiceDid(): string {
  return process.env.PDS_SERVICE_DID?.trim() || `did:web:${config.pds.hostname}`;
}

/**
 * Verify an inbound service-auth JWT.
 *
 * Returns the parsed claims on success. Throws ServiceAuthError on failure.
 * Callers MUST call markServiceAuthJwtUsed() after verification to enforce
 * replay protection.
 */
export async function verifyServiceAuthJwt(
  token: string,
  opts: ServiceAuthVerifyOptions = {}
): Promise<ServiceAuthClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new ServiceAuthError('InvalidToken', 'Malformed JWT');
  }
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; typ?: string };
  let payload: ServiceAuthClaims & Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecodeString(headerB64));
    payload = JSON.parse(base64UrlDecodeString(payloadB64));
  } catch {
    throw new ServiceAuthError('InvalidToken', 'Malformed JWT header or payload');
  }

  if (!header.alg || !SUPPORTED_ALGS.has(header.alg)) {
    throw new ServiceAuthError('InvalidToken', `Unsupported JWT alg: ${header.alg ?? 'none'}`);
  }

  const { iss, aud, exp } = payload;
  if (typeof iss !== 'string' || !iss.startsWith('did:')) {
    throw new ServiceAuthError('InvalidToken', 'Missing or invalid iss');
  }
  if (typeof aud !== 'string' || !aud.startsWith('did:')) {
    throw new ServiceAuthError('InvalidToken', 'Missing or invalid aud');
  }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new ServiceAuthError('InvalidToken', 'Missing or invalid exp');
  }

  const expectedAud = opts.expectedAud ?? getServiceDid();
  if (aud !== expectedAud) {
    throw new ServiceAuthError('BadAudience', `Token aud "${aud}" does not match this service`, 401);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSec ?? 30;
  if (exp + skew < nowSec) {
    throw new ServiceAuthError('ExpiredToken', 'JWT has expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - skew > nowSec) {
    throw new ServiceAuthError('TokenNotYetValid', 'JWT not yet valid (nbf)');
  }
  if (typeof payload.iat === 'number' && payload.iat - skew > nowSec) {
    throw new ServiceAuthError('InvalidToken', 'JWT iat is in the future');
  }

  if (opts.expectedLxm && typeof payload.lxm === 'string' && payload.lxm !== opts.expectedLxm) {
    throw new ServiceAuthError('BadLexiconMethod', `Token lxm "${payload.lxm}" does not match method "${opts.expectedLxm}"`, 403);
  }

  // Resolve iss → atproto signing key → verify signature
  let signingKeyDidKey: string;
  try {
    signingKeyDidKey = opts.resolveSigningKey
      ? await opts.resolveSigningKey(iss)
      : await getDidResolver().resolveAtprotoKey(iss);
  } catch (err) {
    throw new ServiceAuthError('IssuerResolutionFailed', `Could not resolve iss DID: ${iss}`);
  }

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = base64UrlDecodeBytes(sigB64);

  let verified: boolean;
  try {
    verified = await verifySignature(signingKeyDidKey, signingInput, sigBytes, {
      jwtAlg: header.alg,
    });
  } catch (err) {
    throw new ServiceAuthError('InvalidSignature', 'JWT signature verification failed');
  }
  if (!verified) {
    throw new ServiceAuthError('InvalidSignature', 'JWT signature did not verify');
  }

  // Replay protection: reject if this exact signature was already accepted
  // within its validity window.
  if (isReplay(sigB64, exp)) {
    throw new ServiceAuthError('ReplayedToken', 'Token has already been used', 401);
  }

  return payload;
}

/**
 * Sign a service-auth JWT for outbound use.
 * Used by com.atproto.server.getServiceAuth.
 */
export async function signServiceAuthJwt(opts: {
  keypair: Keypair;
  iss: string;
  aud: string;
  exp: number;
  lxm?: string;
}): Promise<string> {
  const alg = opts.keypair.jwtAlg; // 'ES256K' or 'ES256'
  const header = { typ: 'JWT', alg };
  const payload: ServiceAuthClaims = {
    iss: opts.iss,
    aud: opts.aud,
    exp: opts.exp,
    iat: Math.floor(Date.now() / 1000),
    jti: randomJti(),
    ...(opts.lxm ? { lxm: opts.lxm } : {}),
  };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await opts.keypair.sign(signingInput);
  const sigB64 = base64UrlEncodeBytes(sig);
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

// ── Replay protection ────────────────────────────────────────────────────────
//
// Short-lived (<= a few minutes) JWTs can be replayed within their validity
// window. We track the signature component — which is a strong unique id for
// a token — with an expiry matching the JWT's `exp`. A periodic sweep keeps
// the map bounded.

const seenSignatures = new Map<string, number>(); // sigB64 → expMs
const MAX_SEEN = 10_000;

function isReplay(sigB64: string, expSec: number): boolean {
  const expMs = expSec * 1000;
  pruneSeen();
  if (seenSignatures.has(sigB64)) {
    return true;
  }
  if (seenSignatures.size >= MAX_SEEN) {
    // Evict oldest entries if we hit the cap.
    const cutoff = Date.now();
    for (const [k, v] of seenSignatures) {
      if (v < cutoff) seenSignatures.delete(k);
      if (seenSignatures.size < MAX_SEEN) break;
    }
  }
  seenSignatures.set(sigB64, expMs);
  return false;
}

function pruneSeen(): void {
  const now = Date.now();
  // Cheap amortized cleanup: sweep only occasionally.
  if (Math.random() < 0.01) {
    for (const [k, v] of seenSignatures) {
      if (v < now) seenSignatures.delete(k);
    }
  }
}

/** Exposed for tests: clear the replay cache. */
export function _clearReplayCache(): void {
  seenSignatures.clear();
}

// ── Per-DID inbound rate limiter ─────────────────────────────────────────────
//
// Federation calls should be constrained per calling DID so a single misbehaving
// PDS can't saturate this server. Sliding-window counters keyed by iss.

const DEFAULT_LIMIT_PER_MIN = parseInt(process.env.SERVICE_AUTH_RATE_LIMIT || '60', 10);
const WINDOW_MS = 60 * 1000;

type WindowState = { windowStart: number; count: number };
const perDidState = new Map<string, WindowState>();

/**
 * Check-and-increment a per-DID counter. Returns false if this call would
 * exceed the limit; true otherwise.
 */
export function checkServiceAuthRateLimit(did: string, limitPerMin = DEFAULT_LIMIT_PER_MIN): boolean {
  const now = Date.now();
  const state = perDidState.get(did);
  if (!state || now - state.windowStart >= WINDOW_MS) {
    perDidState.set(did, { windowStart: now, count: 1 });
    return true;
  }
  if (state.count >= limitPerMin) {
    return false;
  }
  state.count += 1;
  return true;
}

/** Exposed for tests. */
export function _resetServiceAuthRateLimiter(): void {
  perDidState.clear();
}

// ── base64url helpers ────────────────────────────────────────────────────────

function base64UrlDecodeString(b64: string): string {
  return Buffer.from(base64UrlToStandard(b64), 'base64').toString('utf-8');
}

function base64UrlDecodeBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64UrlToStandard(b64), 'base64'));
}

function base64UrlToStandard(b64: string): string {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  else if (pad !== 0) throw new Error('Invalid base64url input');
  return s;
}

function base64UrlEncodeString(s: string): string {
  return Buffer.from(s, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomJti(): string {
  return base64UrlEncodeBytes(randomBytes(16));
}
