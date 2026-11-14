/**
 * The service DID this dashboard's own PDS signs pen-name logins for, pinned
 * at build time (NEXT_PUBLIC_PDS_SERVICE_DID), as @open-federation/pseudonym
 * recommends, instead of taken from the server's describeServer answer. When
 * it is set, a server at this dashboard's address that names another DID is
 * refused before any pen name signs in or is created there. Unset: the DID
 * describeServer names is used, as before. Other servers (a pen name living
 * elsewhere, a move's new home) are not pinned: the person typed their address.
 */
import { MoveError } from '@/lib/move/xrpc';
import { THIS_PDS, THIS_PDS_SERVICE_DID } from '@/lib/this-pds';

const trim = (u: string) => u.replace(/\/+$/, '');

/** A server lookup's failure in words: a pinned-DID mismatch as it is, anything else as `fallback: message`. */
export function serverProblem(err: unknown, fallback: string): string {
  const e = err as (Error & { code?: string }) | null;
  if (e?.code === 'ServiceDidMismatch') return e.message;
  return `${fallback}: ${e?.message ?? 'no answer'}`;
}

export function assertPinnedServiceDid(url: string, did: string, thisPds: string = THIS_PDS, pinned: string = THIS_PDS_SERVICE_DID): void {
  if (!pinned || trim(url) !== trim(thisPds) || did === pinned) return;
  throw new MoveError(
    `This server says it is ${did || 'no DID at all'}, but this dashboard was set up for ${pinned}. Nothing was signed or sent. Ask the people who run the server: the address may point at another server, or the dashboard's setting may be out of date.`,
    'ServiceDidMismatch',
  );
}
