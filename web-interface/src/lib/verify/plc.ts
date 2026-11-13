/** Which PLC directory the public verifier reads. */
export const DEFAULT_PLC_URL = 'https://plc.openfederation.net';

const trim = (url: string) => url.replace(/\/+$/, '');

/**
 * The directory this dashboard's PDS uses (getPublicConfig.plcDirectoryUrl),
 * or plc.openfederation.net. In development only, `?plc=<url>` points the
 * page at another directory (e.g. the dev PLC on localhost:2582).
 */
export async function verifierPlcUrl(search: string): Promise<string> {
  if (process.env.NODE_ENV === 'development') {
    const override = new URLSearchParams(search).get('plc');
    if (override && /^https?:\/\/[^\s]+$/.test(override)) return trim(override);
  }
  const pds = process.env.NEXT_PUBLIC_PDS_URL;
  if (pds) {
    try {
      const res = await fetch(`${trim(pds)}/xrpc/net.openfederation.server.getPublicConfig`, { signal: AbortSignal.timeout(8000) });
      const config = res.ok ? (await res.json()) as { plcDirectoryUrl?: string } : {};
      if (config.plcDirectoryUrl) return trim(config.plcDirectoryUrl);
    } catch { /* fall back to the public directory */ }
  }
  return DEFAULT_PLC_URL;
}
