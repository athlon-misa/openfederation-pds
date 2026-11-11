/**
 * Plain XRPC calls to any PDS, for the move flows: they talk to two servers
 * (this one and the new home), so they cannot use the dashboard's client,
 * which is bound to this PDS and its session.
 */
export class MoveError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export function normaliseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function call<T>(
  base: string,
  nsid: string,
  opts: { jwt?: string; body?: unknown; query?: Record<string, string>; raw?: BodyInit; contentType?: string } = {},
): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : '';
  const post = opts.body !== undefined || opts.raw !== undefined;
  let res: Response;
  try {
    res = await fetch(`${base}/xrpc/${nsid}${qs}`, {
      method: post ? 'POST' : 'GET',
      headers: {
        ...(opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}),
        ...(opts.raw !== undefined ? { 'Content-Type': opts.contentType ?? 'application/octet-stream' } : opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    throw new MoveError(`Could not reach ${base} (${nsid}). Check the address and that the server allows browser requests.`);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new MoveError(`${nsid}: ${json.message || json.error || res.status}`, json.error);
  return json;
}

export type MigrationPolicy = 'open' | 'invite' | 'token' | 'closed';

export interface TargetInfo {
  url: string;
  serviceDid: string;
  handleDomains: string[];
  /** Null when the server is not an OpenFederation PDS and publishes no policy. */
  migration: { accounts?: MigrationPolicy; pseudonyms?: MigrationPolicy; communities?: MigrationPolicy } | null;
}

/** What the new home tells about itself before anything is sent there. */
export async function describeTarget(rawUrl: string): Promise<TargetInfo> {
  const url = normaliseUrl(rawUrl);
  const described = await call<{ did: string; availableUserDomains?: string[] }>(url, 'com.atproto.server.describeServer');
  const config = await call<{ migration?: TargetInfo['migration'] }>(url, 'net.openfederation.server.getPublicConfig').catch(() => null);
  return { url, serviceDid: described.did, handleDomains: described.availableUserDomains ?? [], migration: config?.migration ?? null };
}

/** This PDS's PLC directory (from its public config). */
export async function plcDirectoryOf(pdsUrl: string): Promise<string> {
  const config = await call<{ plcDirectoryUrl?: string }>(pdsUrl, 'net.openfederation.server.getPublicConfig');
  if (!config.plcDirectoryUrl) throw new MoveError('This server does not say which PLC directory it uses');
  return config.plcDirectoryUrl.replace(/\/+$/, '');
}
