export interface VerifiedSession {
  did: string;
  handle: string;
}

export interface VerifyPdsTokenOptions {
  /**
   * PDS URL to verify the token against directly.
   * When set, skips DID-based PDS discovery entirely.
   * Use this when you know which PDS issued the token (most common case).
   */
  pdsUrl?: string;
  /** PLC directory URL for DID-based PDS discovery (default: https://plc.openfederation.net) */
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
 * Extract the DID from a JWT payload.
 * Checks the `did` claim first (OpenFederation PDS tokens use this),
 * then falls back to `sub` (standard ATProto tokens put the DID there).
 */
function extractDid(payload: Record<string, unknown>): string | null {
  // OpenFederation PDS: sub=UUID, did=DID
  if (typeof payload.did === 'string' && payload.did.startsWith('did:')) {
    return payload.did;
  }
  // Standard ATProto: sub=DID
  if (typeof payload.sub === 'string' && payload.sub.startsWith('did:')) {
    return payload.sub;
  }
  return null;
}

/**
 * Verify a PDS access token by calling `com.atproto.server.getSession`.
 *
 * Two modes of operation:
 *
 * **Known PDS** (recommended for most apps):
 * Pass `pdsUrl` to verify directly against a known PDS. This works for
 * all users (local and external/federated) because the issuing PDS can
 * verify any token it created.
 *
 * ```ts
 * const session = await verifyPdsToken(token, {
 *   pdsUrl: 'https://pds.openfederation.net',
 * });
 * ```
 *
 * **DID-based discovery** (for multi-PDS environments):
 * Omit `pdsUrl` to resolve the user's PDS from the PLC directory.
 * Note: this won't work for federated/external users whose DID points
 * to a different PDS than the one that issued the token.
 *
 * ```ts
 * const session = await verifyPdsToken(token, {
 *   plcDirectoryUrl: 'https://plc.openfederation.net',
 * });
 * ```
 *
 * @returns `{ did, handle }` on success, `null` on any failure
 */
export async function verifyPdsToken(
  accessToken: string,
  options?: VerifyPdsTokenOptions,
): Promise<VerifiedSession | null> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT;

  // 1. Decode JWT to extract the DID
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;

  const did = extractDid(payload);
  if (!did) return null;

  // Optional: check expected DID early
  if (options?.expectedDid && did !== options.expectedDid) return null;

  // 2. Determine the PDS endpoint
  let pdsEndpoint: string;

  if (options?.pdsUrl) {
    // Known PDS — skip DID resolution
    pdsEndpoint = options.pdsUrl.replace(/\/$/, '');
  } else {
    // DID-based discovery via PLC directory
    const plcUrl = (options?.plcDirectoryUrl || DEFAULT_PLC_URL).replace(/\/$/, '');
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
  }

  // 3. Verify token by calling getSession on the PDS
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

    // 4. Verify returned DID matches the token's DID claim
    if (!session.did || !session.handle || session.did !== did) return null;

    return { did: session.did, handle: session.handle };
  } catch {
    return null;
  }
}
