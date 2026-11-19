/**
 * HTTP signatures for ActivityPub deliveries (draft-cavage-http-signatures-12,
 * `rsa-sha256`), the scheme Mastodon, Lemmy and Ghost use to sign and check
 * server-to-server POSTs.
 *
 * Signing: `(request-target) host date digest`, with a SHA-256 Digest of the
 * body. Verifying: the same headers must be covered, the Date must be recent
 * and the Digest must match the body that arrived.
 */
import crypto from 'crypto';

/** How far a signed Date may be from now (Mastodon allows one hour either way). */
export const SIGNATURE_MAX_SKEW_MS = 60 * 60 * 1000;

/** Headers a signed POST must cover for this server to accept it. */
const REQUIRED_POST_HEADERS = ['(request-target)', 'host', 'date', 'digest'];

export function digestHeader(body: string | Buffer): string {
  return `SHA-256=${crypto.createHash('sha256').update(body).digest('base64')}`;
}

function signingString(headerNames: string[], method: string, path: string, headers: Record<string, string>): string {
  return headerNames.map((name) => name === '(request-target)'
    ? `(request-target): ${method.toLowerCase()} ${path}`
    : `${name}: ${headers[name] ?? ''}`).join('\n');
}

/** The headers to send with a signed POST of `body` to `url`. */
export function signedPostHeaders(opts: {
  url: string;
  body: string;
  keyId: string;
  privateKeyPem: string;
  date?: Date;
}): Record<string, string> {
  const url = new URL(opts.url);
  const headers: Record<string, string> = {
    host: url.host,
    date: (opts.date ?? new Date()).toUTCString(),
    digest: digestHeader(opts.body),
  };
  const names = REQUIRED_POST_HEADERS;
  const signature = crypto.createSign('sha256')
    .update(signingString(names, 'POST', `${url.pathname}${url.search}`, headers))
    .sign(opts.privateKeyPem, 'base64');
  return {
    Host: headers.host,
    Date: headers.date,
    Digest: headers.digest,
    'Content-Type': 'application/activity+json',
    Signature: `keyId="${opts.keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${signature}"`,
  };
}

export interface ParsedSignature {
  keyId: string;
  algorithm: string | null;
  headers: string[];
  signature: string;
}

/**
 * Parse a Signature header: comma-separated `name="value"` pairs. Linear,
 * no regular expressions over the whole header.
 */
export function parseSignatureHeader(raw: string | undefined): ParsedSignature | null {
  if (!raw || raw.length > 4096) return null;
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < raw.length) {
    while (raw[i] === ' ' || raw[i] === ',') i++;
    const eq = raw.indexOf('=', i);
    if (eq < 0) break;
    const name = raw.slice(i, eq).trim().toLowerCase();
    if (raw[eq + 1] !== '"') return null;
    const end = raw.indexOf('"', eq + 2);
    if (end < 0) return null;
    fields[name] = raw.slice(eq + 2, end);
    i = end + 1;
  }
  if (!fields.keyid || !fields.signature) return null;
  return {
    keyId: fields.keyid,
    algorithm: fields.algorithm ?? null,
    headers: (fields.headers ?? 'date').toLowerCase().split(' ').filter(Boolean),
    signature: fields.signature,
  };
}

export type VerifyFailure =
  | 'missing_signature'
  | 'unsupported_algorithm'
  | 'headers_not_covered'
  | 'stale_date'
  | 'digest_mismatch'
  | 'bad_signature';

/**
 * Check a signed POST against the signer's public key. `path` is the request
 * target exactly as sent (path and query); `headers` are the received headers
 * with lower-case names.
 */
export function verifySignedPost(opts: {
  signature: ParsedSignature;
  path: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
  publicKeyPem: string;
  now?: number;
}): VerifyFailure | null {
  const { signature } = opts;
  // hs2019 is how newer servers label the same RSA-SHA256 signature.
  if (signature.algorithm && !['rsa-sha256', 'hs2019'].includes(signature.algorithm.toLowerCase())) {
    return 'unsupported_algorithm';
  }
  if (!REQUIRED_POST_HEADERS.every((h) => signature.headers.includes(h))) return 'headers_not_covered';

  const date = Date.parse(opts.headers.date ?? '');
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(date) || Math.abs(now - date) > SIGNATURE_MAX_SKEW_MS) return 'stale_date';
  // "SHA-256=<base64>", possibly among other digests; the algorithm name is case-insensitive.
  const expected = digestHeader(opts.body).slice('SHA-256='.length);
  const sha256 = (opts.headers.digest ?? '').split(',').map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith('sha-256='));
  if (!sha256 || sha256.slice('sha-256='.length) !== expected) return 'digest_mismatch';

  const received: Record<string, string> = {};
  for (const name of signature.headers) {
    if (name === '(request-target)') continue;
    const value = opts.headers[name];
    if (value === undefined) return 'headers_not_covered';
    received[name] = value;
  }
  let ok = false;
  try {
    ok = crypto.createVerify('sha256')
      .update(signingString(signature.headers, 'POST', opts.path, received))
      .verify(opts.publicKeyPem, signature.signature, 'base64');
  } catch {
    ok = false;
  }
  return ok ? null : 'bad_signature';
}
