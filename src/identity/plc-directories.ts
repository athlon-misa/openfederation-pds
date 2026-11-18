/**
 * Which PLC directories this server reads DIDs from.
 *
 * A did:plc is registered in one directory: this server's (PLC_DIRECTORY_URL)
 * for the identities it creates, plc.directory for most of the AT Protocol
 * network. A server that only asked its own directory could not recognise a
 * Bluesky account; one that only asked plc.directory could not recognise its
 * own. So reads go through an ordered list (PLC_RESOLVER_URLS), and the first
 * directory that knows a DID answers for it.
 *
 * Writes are unaffected: new identities are still registered with
 * PLC_DIRECTORY_URL only (src/identity/plc-client.ts).
 *
 * Order is trust. A directory that holds a stale copy of a DID (one that
 * missed a later key rotation) would serve the old keys if it came first, so
 * list only directories that are authoritative for the DIDs they hold, the
 * one this server registers with first.
 */

import { DidPlcResolver } from '@atproto/identity';

/** The network-wide directory, consulted after this server's own by default. */
export const PUBLIC_PLC_DIRECTORY = 'https://plc.directory';

function normalizeUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name}: "${raw}" is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name}: "${raw}" must be an http(s) URL`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name}: "${raw}" must not have a query or fragment`);
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * The ordered, de-duplicated list of directories to read from.
 *
 * Unset: this server's own directory, then plc.directory. Set: exactly the
 * listed directories, in that order; this server's own directory is put first
 * when it is missing, since a DID this server created must always resolve
 * here. `none` (case-insensitive) as the only entry means "own directory
 * only". An entry that is not an http(s) URL throws, so the server refuses to
 * start rather than silently resolving against fewer directories.
 */
export function parsePlcResolverUrls(raw: string | undefined, ownDirectory: string): string[] {
  const own = normalizeUrl(ownDirectory, 'PLC_DIRECTORY_URL');
  const entries = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return dedupe([own, PUBLIC_PLC_DIRECTORY]);
  if (entries.length === 1 && entries[0].toLowerCase() === 'none') return [own];
  const listed = entries.map((e) => normalizeUrl(e, 'PLC_RESOLVER_URLS'));
  return dedupe(listed.includes(own) ? listed : [own, ...listed]);
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

/**
 * A did:plc method for @atproto/identity's DidResolver that asks each
 * directory in turn. A directory answering 404 ("positively not found") or
 * failing moves on to the next; the DID is unknown only when every directory
 * said so. When none answered and at least one failed, the last failure is
 * thrown, so a network outage is not reported as "no such DID".
 *
 * Extends DidPlcResolver because BaseResolver is not exported by
 * @atproto/identity; `plcUrl` is the first (this server's own) directory.
 */
export class MultiPlcResolver extends DidPlcResolver {
  readonly directories: DidPlcResolver[];

  constructor(urls: string[], timeout: number) {
    if (urls.length === 0) throw new Error('MultiPlcResolver needs at least one directory');
    super(urls[0], timeout);
    this.directories = urls.map((u) => new DidPlcResolver(u, timeout));
  }

  async resolveNoCheck(did: string): Promise<unknown> {
    let failure: unknown = null;
    for (const directory of this.directories) {
      try {
        const doc = await directory.resolveNoCheck(did);
        if (doc) return doc;
      } catch (err) {
        failure = err;
      }
    }
    if (failure) throw failure;
    return null;
  }
}
