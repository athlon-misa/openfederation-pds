/**
 * Strip the PDS domain suffix from a handle for display.
 * "alice.openfederation.net" → "alice"
 * "alice" → "alice" (already short)
 */
export function displayHandle(handle: string, suffix?: string): string {
  const s = suffix || '.openfederation.net';
  if (handle.endsWith(s)) {
    return handle.slice(0, -s.length);
  }
  return handle;
}

/**
 * Build an XRPC URL from a server base URL and NSID.
 */
export function xrpcUrl(
  serverUrl: string,
  nsid: string,
  params?: Record<string, string>
): string {
  const base = serverUrl.replace(/\/$/, '');
  let url = `${base}/xrpc/${nsid}`;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(params).toString();
    url += `?${qs}`;
  }
  return url;
}

/**
 * Parse a token-expiry value into Unix milliseconds, robust against the
 * various shapes OAuth SDKs return it as.
 *
 * AT Protocol's `@atproto/oauth-client-node` (and generic OAuth 2.0 SDKs)
 * can report `expires_at` as:
 *   - an ISO-8601 string (`"2026-04-21T15:00:00Z"`)
 *   - a Unix epoch in **seconds** (`1745251200`)
 *   - a Unix epoch in **milliseconds** (`1745251200000`)
 *
 * Passing a seconds-epoch to `new Date(n)` silently treats it as milliseconds
 * (so 1745251200 → 1970-01-21). Passing an unparseable string yields `NaN`.
 * Both failure modes poison downstream freshness checks with no error — the
 * session looks authenticated but every request 401s.
 *
 * This helper normalizes to a finite milliseconds value and, when it can't,
 * returns the caller-provided fallback (default: 1 hour from now) instead
 * of NaN. It is exported from the SDK so every BFF / session layer doesn't
 * re-derive the same fragile parsing.
 *
 * @example
 * ```ts
 * import { parseTokenExpiry } from '@open-federation/sdk';
 *
 * session.accessTokenExpiresAt = parseTokenExpiry(tokenSet.expires_at);
 * // — or with a custom fallback:
 * session.accessTokenExpiresAt = parseTokenExpiry(tokenSet.expires_at, {
 *   fallbackMs: Date.now() + 30 * 60 * 1000,
 * });
 * ```
 */
export function parseTokenExpiry(
  value: unknown,
  opts: { fallbackMs?: number } = {}
): number {
  const fallback = opts.fallbackMs ?? Date.now() + 60 * 60 * 1000;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: anything below ~Sep 2001 in milliseconds (< 1e12) must
    // actually be seconds. Values ≥ 1e12 are already milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    return Number.isFinite(ms) ? ms : fallback;
  }

  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
    // Accept numeric strings too (some SDKs stringify).
    const asNum = Number(value);
    if (Number.isFinite(asNum)) {
      const normalized = asNum < 1e12 ? asNum * 1000 : asNum;
      if (Number.isFinite(normalized)) return normalized;
    }
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return ms;
  }

  return fallback;
}
