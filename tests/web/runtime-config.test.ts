import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  RUNTIME_CONFIG_GLOBAL, normalizePdsUrl, serverPdsUrl, resolvePdsUrl, runtimeConfigScript,
} from '../../web-interface/src/lib/runtime-config';

describe('dashboard runtime config: PDS address', () => {
  it('accepts http(s) origins and paths, dropping trailing slashes', () => {
    expect(normalizePdsUrl('https://pds.example.org')).toBe('https://pds.example.org');
    expect(normalizePdsUrl('https://pds.example.org/')).toBe('https://pds.example.org');
    expect(normalizePdsUrl('  http://localhost:8080// ')).toBe('http://localhost:8080');
    expect(normalizePdsUrl('https://example.org/pds/')).toBe('https://example.org/pds');
  });

  it('rejects anything that is not a plain http(s) address', () => {
    for (const bad of [undefined, '', '   ', 'pds.example.org', 'javascript:alert(1)', 'ftp://x.org',
      'https://user:pw@pds.example.org', 'https://pds.example.org/?q=1', 'https://pds.example.org/#x', 'not a url']) {
      expect(normalizePdsUrl(bad)).toBeNull();
    }
  });

  it('prefers PDS_URL (runtime) over NEXT_PUBLIC_PDS_URL (build time)', () => {
    expect(serverPdsUrl({ PDS_URL: 'https://a.example', NEXT_PUBLIC_PDS_URL: 'https://b.example' })).toBe('https://a.example');
    expect(serverPdsUrl({ NEXT_PUBLIC_PDS_URL: 'https://b.example/' })).toBe('https://b.example');
    expect(serverPdsUrl({ PDS_URL: 'garbage', NEXT_PUBLIC_PDS_URL: 'https://b.example' })).toBe('https://b.example');
    expect(serverPdsUrl({})).toBeNull();
  });

  it('resolves in the browser from the injected config, then the build-time value, then the development default', () => {
    expect(resolvePdsUrl({ injected: { pdsUrl: 'https://run.example' }, buildTime: 'https://build.example' })).toBe('https://run.example');
    expect(resolvePdsUrl({ injected: { pdsUrl: null }, buildTime: 'https://build.example' })).toBe('https://build.example');
    expect(resolvePdsUrl({ injected: undefined, buildTime: undefined })).toBe('http://localhost:3000');
    expect(resolvePdsUrl({ injected: { pdsUrl: 'javascript:1' }, buildTime: undefined })).toBe('http://localhost:3000');
  });

  it('renders a script that sets a frozen global the browser can read', () => {
    const script = runtimeConfigScript({ PDS_URL: 'https://pds.example.org/' });
    const sandbox: Record<string, unknown> = {};
    sandbox.window = sandbox;
    runInNewContext(script, sandbox);
    const config = sandbox[RUNTIME_CONFIG_GLOBAL] as { pdsUrl: string };
    expect(config).toEqual({ pdsUrl: 'https://pds.example.org' });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('renders null when nothing usable is configured, so the build-time fallback applies', () => {
    const sandbox: Record<string, unknown> = {};
    sandbox.window = sandbox;
    runInNewContext(runtimeConfigScript({ PDS_URL: 'https://x.org/</script><script>alert(1)//' }), sandbox);
    expect((sandbox[RUNTIME_CONFIG_GLOBAL] as { pdsUrl: unknown }).pdsUrl).toBeNull();
  });

  it('never lets a value close the script or inject markup', () => {
    const script = runtimeConfigScript({ PDS_URL: 'https://x.org/a<b>' });
    expect(script).not.toMatch(/[<>]/);
  });
});
