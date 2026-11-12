/**
 * Helpers for showing community.discover results. Peer URLs are validated by
 * the server, but the page still builds links only from plain http(s) URLs.
 */

/** The URL when `value` is an absolute http(s) URL without credentials, else null. */
export function httpUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url;
}

/** Host (with port) of an http(s) URL; anything else is shown as given, as text. */
export function hostLabel(value: string): string {
  return httpUrl(value)?.host ?? value;
}

const PEER_ERRORS: Record<string, string> = {
  Timeout: 'timed out',
  Unreachable: 'unreachable',
  BlockedUrl: 'address not allowed',
  HttpError: 'server error',
  InvalidResponse: 'invalid response',
  ResponseTooLarge: 'response too large',
};

/** Short description of why a peer did not answer. */
export function peerErrorLabel(error: string | undefined): string {
  if (!error) return 'no answer';
  return PEER_ERRORS[error] ?? error;
}
