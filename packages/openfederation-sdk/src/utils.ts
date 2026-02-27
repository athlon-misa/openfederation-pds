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
