/**
 * Outbound guard for SIWOF did:web resolution (issue #97).
 *
 * The SDK is a separate package with no test runner of its own, so its guard is
 * exercised from here — this suite runs in CI via `npm run test:api` and would
 * otherwise have no coverage at all.
 *
 * Every case drives the real `fetchGuarded` / `resolveAtprotoKey`. The only
 * injected part is `fetchImpl`, which records what the guard *would* have
 * requested; a destination that is supposed to be blocked must never reach it.
 */
import { describe, it, expect } from 'vitest';
import {
  fetchGuarded,
  isBlockedAddress,
  assertPublicHttpsUrl,
  OutboundFetchError,
} from '../../packages/openfederation-sdk/src/siwof/net-guard.js';
import { resolveAtprotoKey } from '../../packages/openfederation-sdk/src/siwof/verify.js';

/** A fetch that records calls and never touches the network. */
function recordingFetch(responder: (url: string) => Response) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    return responder(url);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

const DID_DOC = {
  verificationMethod: [{ id: 'did:web:example.com#atproto', publicKeyMultibase: 'zQ3shTESTKEY' }],
};

describe('isBlockedAddress', () => {
  it.each([
    ['localhost', true],
    ['app.localhost', true],
    ['127.0.0.1', true],
    ['0.0.0.0', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata
    ['100.64.0.1', true],      // CGNAT
    ['198.18.0.1', true],
    ['203.0.113.5', true],
    ['224.0.0.1', true],
    ['::1', true],
    ['fc00::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true], // v4-mapped loopback
    ['93.184.216.34', false],   // public
    ['example.com', false],
    ['172.32.0.1', false],      // just outside the private range
  ])('%s -> blocked=%s', (host, blocked) => {
    expect(isBlockedAddress(host)).toBe(blocked);
  });
});

describe('assertPublicHttpsUrl', () => {
  it('rejects non-HTTPS schemes', () => {
    expect(() => assertPublicHttpsUrl('http://example.com/x')).toThrow(OutboundFetchError);
    expect(() => assertPublicHttpsUrl('file:///etc/passwd')).toThrow(OutboundFetchError);
  });

  it('rejects embedded credentials', () => {
    expect(() => assertPublicHttpsUrl('https://user:pw@example.com/x')).toThrow(/credentials/);
  });

  it('rejects literal internal addresses', () => {
    expect(() => assertPublicHttpsUrl('https://169.254.169.254/latest/meta-data/')).toThrow(/private or reserved/);
  });

  it('accepts a plain public HTTPS URL', () => {
    expect(assertPublicHttpsUrl('https://example.com/.well-known/did.json').hostname).toBe('example.com');
  });
});

describe('fetchGuarded', () => {
  it('never issues the request for a blocked destination', async () => {
    const { calls, impl } = recordingFetch(() => jsonResponse(DID_DOC));
    await expect(
      fetchGuarded('https://169.254.169.254/latest/meta-data/', { fetchImpl: impl }),
    ).rejects.toThrow(OutboundFetchError);
    expect(calls).toEqual([]); // the point: nothing left the process
  });

  it('re-validates each redirect hop and refuses one that turns inward', async () => {
    const { calls, impl } = recordingFetch((url) =>
      url.startsWith('https://example.com')
        ? redirectTo('https://127.0.0.1/admin')
        : jsonResponse({ secret: true }),
    );
    await expect(
      fetchGuarded('https://example.com/.well-known/did.json', { fetchImpl: impl }),
    ).rejects.toThrow(/private or reserved/);
    // The public first hop is fetched; the internal second hop never is.
    expect(calls).toEqual(['https://example.com/.well-known/did.json']);
  });

  it('follows a redirect that stays public', async () => {
    const { calls, impl } = recordingFetch((url) =>
      url === 'https://example.com/.well-known/did.json'
        ? redirectTo('https://www.example.com/.well-known/did.json')
        : jsonResponse(DID_DOC),
    );
    const body = await fetchGuarded('https://example.com/.well-known/did.json', { fetchImpl: impl });
    expect(JSON.parse(body)).toEqual(DID_DOC);
    expect(calls).toHaveLength(2);
  });

  it('stops after the redirect budget', async () => {
    let n = 0;
    const { impl } = recordingFetch(() => redirectTo(`https://example.com/hop${n++}`));
    await expect(
      fetchGuarded('https://example.com/start', { fetchImpl: impl, maxRedirects: 2 }),
    ).rejects.toThrow(/redirected too many times/);
  });

  it('refuses a redirect whose target it cannot read (opaque, as in a browser)', async () => {
    const { impl } = recordingFetch(() => new Response(null, { status: 302 })); // no location
    await expect(
      fetchGuarded('https://example.com/x', { fetchImpl: impl }),
    ).rejects.toThrow(/could not be validated/);
  });

  it('caps the response body', async () => {
    const { impl } = recordingFetch(() => new Response('x'.repeat(5000), { status: 200 }));
    await expect(
      fetchGuarded('https://example.com/x', { fetchImpl: impl, maxBytes: 1000 }),
    ).rejects.toThrow(/too large/);
  });

  it('surfaces a non-OK status', async () => {
    const { impl } = recordingFetch(() => new Response('nope', { status: 404 }));
    await expect(
      fetchGuarded('https://example.com/x', { fetchImpl: impl }),
    ).rejects.toThrow(/\(404\)/);
  });
});

describe('resolveAtprotoKey — the reported attack path', () => {
  it('blocks an attacker-named did:web pointing at cloud metadata', async () => {
    const { calls, impl } = recordingFetch(() => jsonResponse(DID_DOC));
    await expect(
      resolveAtprotoKey('did:web:169.254.169.254', 'https://plc.directory', { fetchImpl: impl }),
    ).rejects.toThrow(/private or reserved/);
    expect(calls).toEqual([]);
  });

  it('blocks did:web with an encoded loopback host and port', async () => {
    const { calls, impl } = recordingFetch(() => jsonResponse(DID_DOC));
    await expect(
      resolveAtprotoKey('did:web:127.0.0.1%3A8080', 'https://plc.directory', { fetchImpl: impl }),
    ).rejects.toThrow(/private or reserved/);
    expect(calls).toEqual([]);
  });

  it('blocks did:web:localhost', async () => {
    const { calls, impl } = recordingFetch(() => jsonResponse(DID_DOC));
    await expect(
      resolveAtprotoKey('did:web:localhost', 'https://plc.directory', { fetchImpl: impl }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('still resolves a legitimate public did:web', async () => {
    const { calls, impl } = recordingFetch(() => jsonResponse(DID_DOC));
    const key = await resolveAtprotoKey('did:web:example.com', 'https://plc.directory', { fetchImpl: impl });
    expect(key).toBe('did:key:zQ3shTESTKEY');
    expect(calls).toEqual(['https://example.com/.well-known/did.json']);
  });

  it('resolves did:web with path segments', async () => {
    const { calls, impl } = recordingFetch(() => jsonResponse(DID_DOC));
    await resolveAtprotoKey('did:web:example.com:users:alice', 'https://plc.directory', { fetchImpl: impl });
    expect(calls).toEqual(['https://example.com/users/alice/did.json']);
  });

  it('leaves did:plc resolution against the configured directory unguarded', async () => {
    // The PLC URL is integrator-supplied, not attacker-supplied, so a local or
    // self-hosted directory must keep working.
    const { calls, impl } = recordingFetch(() => jsonResponse(DID_DOC));
    const key = await resolveAtprotoKey('did:plc:abc123', 'http://localhost:2582', { fetchImpl: impl });
    expect(key).toBe('did:key:zQ3shTESTKEY');
    expect(calls).toEqual(['http://localhost:2582/did:plc:abc123']);
  });

  it('rejects a DID document that is not valid JSON', async () => {
    const { impl } = recordingFetch(() => new Response('<html>nope</html>', { status: 200 }));
    await expect(
      resolveAtprotoKey('did:web:example.com', 'https://plc.directory', { fetchImpl: impl }),
    ).rejects.toThrow(/not valid JSON/);
  });
});
