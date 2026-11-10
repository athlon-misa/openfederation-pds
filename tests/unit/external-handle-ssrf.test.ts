import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _clearExternalHandleCache, resolveExternalHandle, isDomainHandle,
} from '../../src/identity/external-handle-resolver.js';

describe('external handle resolution does not reach internal hosts', () => {
  afterEach(() => { vi.unstubAllGlobals(); _clearExternalHandleCache(); });

  it('only treats real domain names as handles', () => {
    for (const ok of ['alice.example.com', 'a-b.example.org', 'xn--bcher-kva.example']) {
      expect(isDomainHandle(ok), ok).toBe(true);
    }
    for (const bad of ['10.0.0.5:8443', '10.0.0.5', '127.0.0.1', 'host/path.example', 'user@evil.example',
      'evil.example:8443', 'localhost', '169.254.169.254', '[::1]', 'a..b', '-a.example', 'a.example/'] ) {
      expect(isDomainHandle(bad), bad).toBe(false);
    }
  });

  it('never fetches for something that is not a domain name', async () => {
    const fetchSpy = vi.fn(async () => new Response('did:plc:abc'));
    vi.stubGlobal('fetch', fetchSpy);
    for (const handle of ['10.0.0.5:8443', '169.254.169.254', 'host.example/..@10.0.0.5', 'internal.example:9200']) {
      expect(await resolveExternalHandle(handle)).toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to follow redirects when fetching the well-known file', async () => {
    const seen: Array<RequestInit | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response('not a did');
    }));
    await resolveExternalHandle('example.com');
    // Asserted out here: inside the stub a failed expectation would be caught
    // by the resolver's own error handling and never surface.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((init) => init?.redirect === 'error')).toBe(true);
  });
});
