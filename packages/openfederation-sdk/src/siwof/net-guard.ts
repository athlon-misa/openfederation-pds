/**
 * Outbound request guard for DID document resolution.
 *
 * `verifySignInAssertion` takes the issuer from an untrusted JWT, so a caller
 * can name any `did:web` host and make the verifying backend fetch it. Without
 * a guard that is a blind SSRF primitive: internal HTTPS services, cloud
 * metadata endpoints, and anything else reachable from the server's network
 * position, all before any signature is checked.
 *
 * The checks are split by what each environment can actually do:
 *
 *   isomorphic  HTTPS only, no embedded credentials, reject literal private,
 *               loopback, link-local and reserved addresses, validate every
 *               redirect hop, bound the response size and the wall-clock time.
 *   Node only   additionally resolve the hostname and re-check every address
 *               it maps to, which is the only way to catch a public name that
 *               points inward.
 *
 * The DNS step uses a dynamic import so bundlers can drop it from the browser
 * builds — the same approach `ethers` uses in the EVM signer adapter, and
 * `node:dns/promises` is listed in tsup's `external` for the same reason. In a
 * browser the import throws, the resolution step is skipped, and the isomorphic
 * checks plus the browser's own network isolation are what remain.
 *
 * This deliberately mirrors `src/security/outbound-fetch.ts` in the PDS rather
 * than importing it: that module is Node-only and this package ships an IIFE
 * browser build. `isBlockedAddress` is kept byte-for-byte identical to it so
 * any divergence is visible in review.
 */

export class OutboundFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundFetchError';
  }
}

/** Matches `src/security/outbound-fetch.ts:isBlockedAddress` in the PDS. */
export function isBlockedAddress(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^(?:fc|fd|fe[89ab])/i.test(host)) return true;

  const match = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  const ipv4 = match?.[1] ?? host;
  const octets = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false;
  const [a, b, c] = octets.slice(1).map(Number);
  if ([a, b, c].some(Number.isNaN) || octets.slice(1).some((part) => Number(part) > 255)) return true;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

/** Pure-JS stand-in for `node:net`'s `isIP`, so this module stays isomorphic. */
export function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(bare)) return true;
  // Loose IPv6: hex groups and colons only, at least one colon. Precision is not
  // required — this only decides whether a DNS lookup is worth attempting, and
  // isBlockedAddress has already rejected the ranges that matter.
  return bare.includes(':') && /^[0-9a-f:.]+$/i.test(bare);
}

/** Reject anything that is not a plainly public HTTPS URL. Isomorphic. */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundFetchError('DID document URL is invalid');
  }
  if (url.protocol !== 'https:') {
    throw new OutboundFetchError('DID document URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new OutboundFetchError('DID document URL must not include credentials');
  }
  if (isBlockedAddress(url.hostname)) {
    throw new OutboundFetchError('DID document URL points at a private or reserved address');
  }
  return url;
}

/**
 * Resolve `host` and reject if any address is private/reserved.
 *
 * No-op wherever `node:dns` is unavailable. That is a real gap in the browser,
 * not a silent pass: there the isomorphic checks plus the browser's own network
 * isolation are the boundary, and the documented use of this verifier is
 * server-side.
 */
async function assertHostResolvesPublic(host: string): Promise<void> {
  if (isIpLiteral(host)) return; // already checked as a literal
  let lookup: (h: string, o: { all: true; verbatim: true }) => Promise<Array<{ address: string }>>;
  try {
    // Indirect specifier so bundlers targeting the browser do not try to resolve it.
    const dns = await import(/* @vite-ignore */ `${'node:dns/promises'}`);
    lookup = dns.lookup;
  } catch {
    return; // not Node — isomorphic checks are all we have
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new OutboundFetchError('DID document hostname could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new OutboundFetchError('DID document URL resolves to a private or reserved address');
  }
}

/** Read at most `maxBytes`, without buffering more than that. Isomorphic. */
export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new OutboundFetchError('DID document response is too large');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new OutboundFetchError('DID document response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export interface GuardedFetchOptions {
  /** Wall-clock budget for the whole exchange, redirects included. */
  timeoutMs?: number;
  /** Hard cap on the response body. DID documents are small. */
  maxBytes?: number;
  /** Redirect hops to follow. Each hop is re-validated from scratch. */
  maxRedirects?: number;
  /** Injected for tests. Defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

const DEFAULTS = { timeoutMs: 5_000, maxBytes: 64 * 1024, maxRedirects: 3 } as const;

/**
 * Fetch a DID document with every hop validated.
 *
 * Redirects are followed manually rather than by the platform, because the
 * platform will happily follow a public URL to an internal one — validating
 * only the first URL is the classic way this guard gets bypassed.
 */
export async function fetchGuarded(
  rawUrl: string,
  options: GuardedFetchOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;
  const doFetch = options.fetchImpl ?? fetch;

  const deadline = Date.now() + timeoutMs;
  let target = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = assertPublicHttpsUrl(target);
    await assertHostResolvesPublic(url.hostname);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new OutboundFetchError('DID document fetch timed out');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        headers: { Accept: 'application/did+json, application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof OutboundFetchError) throw err;
      const aborted = (err as { name?: string } | null)?.name === 'AbortError';
      throw new OutboundFetchError(
        aborted ? 'DID document fetch timed out' : 'DID document could not be fetched',
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        // A browser turns a manual redirect into an opaque response whose headers
        // are unreadable, so the hop cannot be validated and must not be followed.
        throw new OutboundFetchError('DID document redirect could not be validated');
      }
      target = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) {
      throw new OutboundFetchError(`DID document fetch failed (${response.status})`);
    }
    return readLimitedText(response, maxBytes);
  }

  throw new OutboundFetchError('DID document redirected too many times');
}
