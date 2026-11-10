import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkOrigin } from '../../src/api/net.openfederation.partner.verifyKey.js';

describe('partner origin verification fetch (production rules)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not fetch plain-http origins', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await checkOrigin('http://partner.example', 'hash', { production: true });
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fetch origins that are internal addresses in disguise', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    for (const origin of ['https://[::ffff:7f00:1]', 'https://[::ffff:a9fe:a9fe]', 'https://127.0.0.1', 'https://10.1.2.3:8443']) {
      const result = await checkOrigin(origin, 'hash', { production: true });
      expect(result.ok, origin).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not echo the low-level fetch error back to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED 10.0.0.7:5432'); }));
    const result = await checkOrigin('http://partner.example', 'hash', { production: false });
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain('10.0.0.7');
    expect(result.reason).not.toContain('ECONNREFUSED');
  });
});
