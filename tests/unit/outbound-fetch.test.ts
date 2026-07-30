import { describe, expect, it } from 'vitest';
import { assertPublicHttpsUrl } from '../../src/security/outbound-fetch.js';

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
});
