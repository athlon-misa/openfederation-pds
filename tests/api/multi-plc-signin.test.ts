/**
 * Signing in an account from any listed PLC directory.
 *
 * The external sign-in client used to resolve DIDs against plc.directory only
 * and handles through DNS only, so an account of this server (DID in this
 * server's own directory, handle under its domain with no DNS record yet)
 * could not be found by it. Both lookups now go through
 * src/identity/plc-directories.ts and the local database first.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { config } from '../../src/config.js';
import { getDidResolver } from '../../src/identity/did-resolver.js';
import { resolveSignInHandle } from '../../src/oauth/external-client.js';
import { createTestUser, isPLCAvailable, uniqueHandle } from './helpers.js';

describe('sign-in resolution across PLC directories', () => {
  let plcAvailable = false;
  let user: { did: string; handle: string; fullHandle: string };

  beforeAll(async () => {
    plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return;
    user = await createTestUser(uniqueHandle('mplc'));
  });

  it('reads this server\'s own directory first, then plc.directory', () => {
    expect(config.plc.resolverUrls[0]).toBe(config.plc.directoryUrl.replace(/\/+$/, ''));
    if (!process.env.PLC_RESOLVER_URLS) {
      expect(config.plc.resolverUrls).toContain('https://plc.directory');
    }
  });

  it('a handle under this server\'s domain resolves from the database, without DNS', async () => {
    if (!plcAvailable) return;
    expect(user.fullHandle.endsWith(config.handleSuffix)).toBe(true);
    expect(await resolveSignInHandle(user.fullHandle)).toBe(user.did);
    expect(await resolveSignInHandle(user.fullHandle.toUpperCase())).toBe(user.did);
  });

  it('a name outside this server\'s domain is never answered from the database', async () => {
    if (!plcAvailable) return;
    // The bare name exists here, but "<name>.invalid" is someone else's
    // namespace: it must not resolve to the local account.
    expect(await resolveSignInHandle(`${user.handle}.invalid`)).toBeNull();
  });

  it('a DID registered in this server\'s directory resolves through the shared resolver', async () => {
    if (!plcAvailable) return;
    const doc = await getDidResolver().resolve(user.did, true);
    expect(doc?.id).toBe(user.did);
  });
});
