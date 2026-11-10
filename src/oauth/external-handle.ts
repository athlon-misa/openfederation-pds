import { isDomainHandle } from '../identity/external-handle-resolver.js';

/** The stand-in handle for an external account whose real handle cannot be used. */
export function placeholderHandle(did: string): string {
  return did.replace(/^did:/, '').replace(/:/g, '-');
}

/**
 * Decide what handle an account signing in from another PDS gets here.
 *
 * The candidate comes from the account's own DID document (`alsoKnownAs`),
 * which its owner writes. Taken on faith, a DID naming `at://admin` would
 * become local user "admin", answer to that name in webfinger, and squat on
 * it. So the candidate is only used when it is a real domain name, is not
 * under this PDS's own handle suffix (those are issued here, not claimed),
 * resolves back to the same DID (the usual atproto two-way check), and is not
 * already in use here. Anything else gets the DID-derived placeholder.
 */
export async function chooseExternalHandle(
  did: string,
  candidate: string | null,
  deps: {
    localSuffix: string;
    resolveHandle: (handle: string) => Promise<string | null>;
    isTaken: (handle: string) => Promise<boolean>;
  },
): Promise<string> {
  const fallback = placeholderHandle(did);
  if (!candidate) return fallback;
  const handle = candidate.toLowerCase();
  if (!isDomainHandle(handle)) return fallback;
  if (deps.localSuffix && handle.endsWith(deps.localSuffix.toLowerCase())) return fallback;
  if ((await deps.resolveHandle(handle)) !== did) return fallback;
  if (await deps.isTaken(handle)) return fallback;
  return handle;
}
