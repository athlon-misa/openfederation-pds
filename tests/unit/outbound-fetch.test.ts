import { describe, expect, it } from 'vitest';
import { assertPublicHttpsUrl, isBlockedAddress, readLimitedBytes, OutboundFetchError } from '../../src/security/outbound-fetch.js';

describe('outbound fetch guard', () => {
  it('rejects a private IPv4 authority even when it includes a port', async () => {
    await expect(
      assertPublicHttpsUrl('https://127.0.0.1:8443/.well-known/did.json'),
    ).rejects.toThrow(/private or reserved/i);
  });

  it('rejects non-HTTPS destinations', async () => {
    await expect(
      assertPublicHttpsUrl('http://example.com/.well-known/did.json'),
    ).rejects.toThrow(/HTTPS/i);
  });

  it('rejects IPv4-mapped IPv6 loopback and private addresses in every spelling', async () => {
    // new URL() normalises [::ffff:127.0.0.1] to the hex form [::ffff:7f00:1].
    expect(new URL('https://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
    for (const host of ['::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:a9fe:a9fe', '::ffff:0a00:0005', '0:0:0:0:0:ffff:c0a8:0101', '::ffff:127.0.0.1']) {
      expect(isBlockedAddress(host), host).toBe(true);
    }
    await expect(assertPublicHttpsUrl('https://[::ffff:127.0.0.1]/x')).rejects.toThrow(/private or reserved/i);
    await expect(assertPublicHttpsUrl('https://[::ffff:169.254.169.254]/x')).rejects.toThrow(/private or reserved/i);
  });

  it('does not block a public IPv4-mapped address', () => {
    expect(isBlockedAddress('::ffff:0808:0808')).toBe(false);
  });

  it('stops reading a response body once it passes the limit', async () => {
    const big = new Response(new Uint8Array(5000));
    await expect(readLimitedBytes(big, 1000)).rejects.toThrow(OutboundFetchError);
    const ok = await readLimitedBytes(new Response(new Uint8Array(500)), 1000);
    expect(ok.length).toBe(500);
  });
});
