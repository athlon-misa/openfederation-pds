/**
 * Checks for data another PDS sends us. Everything a peer says is untrusted:
 * identifiers must have their real shape, text is cleaned and cut to length,
 * and links must be http(s), so nothing a peer sends can become a script
 * link in the dashboard.
 */

export const DID_PATTERN = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9._%-]+(?::[a-zA-Z0-9._%-]+)*)$/;
export const HANDLE_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function isPeerDid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && DID_PATTERN.test(value);
}

export function isPeerHandle(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && HANDLE_PATTERN.test(value);
}

/** Control characters become spaces; trimmed; cut to `max`. Anything not a string is ''. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL_CHARS, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

/** The origin of an http(s) URL, or null for anything else (javascript:, data:, garbage). */
export function safeHttpOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A non-negative integer, capped; null when the value is not one. */
export function peerCount(value: unknown, cap = 1_000_000_000): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return Math.min(value, cap);
}
