import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveFromPlc, getPlcLog } from '../../src/identity/plc-client.js';
import { resolveDidToPds } from '../../src/federation/remote-verify.js';
import { base64UrlEncodeForTests } from '../../src/auth/service-auth.js';

afterEach(() => vi.restoreAllMocks());

describe('PLC lookups only for well-formed did:plc identifiers', () => {
  for (const bad of ['did:plc:x/../export', 'did:plc:abc?x=1', 'did:plc:ABCDEFGHIJKLMNOPQRSTUVWX', 'did:plc:short']) {
    it(`does not fetch for ${bad}`, async () => {
      const spy = vi.spyOn(globalThis, 'fetch');
      await expect(resolveFromPlc(bad)).rejects.toThrow(/did:plc/);
      await expect(getPlcLog(bad)).rejects.toThrow(/did:plc/);
      expect(await resolveDidToPds(bad)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  }
});

describe('did:web hosts', () => {
  it('does not fetch for a did:web with a path or credentials in the host part', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const bad of ['did:web:evil.example/x', 'did:web:user@evil.example', 'did:web:evil.example#frag']) {
      expect(await resolveDidToPds(bad)).toBeNull();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('base64url encoding', () => {
  it('strips padding in linear time on long inputs', () => {
    const started = Date.now();
    const out = base64UrlEncodeForTests('a'.repeat(200_000));
    expect(out.endsWith('=')).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
