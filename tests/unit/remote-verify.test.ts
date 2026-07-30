import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDidToPds } from '../../src/federation/remote-verify.js';

describe('federation remote verification destinations', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a did:web loopback authority with a port before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveDidToPds('did:web:127.0.0.1:8443')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
