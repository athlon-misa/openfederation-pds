export interface VerifiedSession {
  did: string;
  handle: string;
}

export interface VerifyPdsTokenOptions {
  /** PLC directory URL (default: https://plc.openfederation.net) */
  plcDirectoryUrl?: string;
  /** If set, verification fails when the token's DID doesn't match */
  expectedDid?: string;
  /** Request timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
}

const DEFAULT_PLC_URL = 'https://plc.openfederation.net';
const DEFAULT_TIMEOUT = 5000;

/**
 * Decode a JWT payload without verification (reads claims only).
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(payload);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

/**
 * Verify a PDS access token by resolving the user's DID to their PDS
 * and calling `com.atproto.server.getSession`.
 *
 * Flow:
 * 1. Decode the JWT to extract the `sub` (DID) claim
 * 2. Resolve the DID document from the PLC directory to find the PDS endpoint
 * 3. Call `getSession` on the resolved PDS with the bearer token
 * 4. Verify the returned DID matches the token's `sub` claim
 *
 * @returns `{ did, handle }` on success, `null` on any failure
 */
export async function verifyPdsToken(
  accessToken: string,
  options?: VerifyPdsTokenOptions,
): Promise<VerifiedSession | null> {
  const plcUrl = (options?.plcDirectoryUrl || DEFAULT_PLC_URL).replace(/\/$/, '');
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT;

  // 1. Decode JWT to get the DID (sub claim)
  const payload = decodeJwtPayload(accessToken);
  if (!payload || typeof payload.sub !== 'string') return null;
  const did = payload.sub as string;

  // Optional: check expected DID early
  if (options?.expectedDid && did !== options.expectedDid) return null;

  // 2. Resolve DID document from PLC directory
  let pdsEndpoint: string;
  try {
    const didRes = await fetch(`${plcUrl}/${encodeURIComponent(did)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!didRes.ok) return null;

    const didDoc = await didRes.json() as {
      service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
    };

    const pdsService = didDoc.service?.find(
      (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer',
    );
    if (!pdsService?.serviceEndpoint) return null;
    pdsEndpoint = pdsService.serviceEndpoint.replace(/\/$/, '');
  } catch {
    return null;
  }

  // 3. Verify token by calling getSession on the resolved PDS
  try {
    const sessionRes = await fetch(
      `${pdsEndpoint}/xrpc/com.atproto.server.getSession`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!sessionRes.ok) return null;

    const session = await sessionRes.json() as { did?: string; handle?: string };

    // 4. Verify returned DID matches the token's sub claim
    if (!session.did || !session.handle || session.did !== did) return null;

    return { did: session.did, handle: session.handle };
  } catch {
    return null;
  }
}
