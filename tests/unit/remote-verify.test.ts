import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _cacheRemoteVerificationForTest,
  _clearRemoteVerificationCache,
  _remoteVerificationCacheSize,
  resolveDidToPds,
} from '../../src/federation/remote-verify.js';

describe('federation remote verification destinations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _clearRemoteVerificationCache();
  });

  it('rejects a did:web loopback authority with a port before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveDidToPds('did:web:127.0.0.1:8443')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps retained remote verification results', () => {
    for (let index = 0; index < 501; index++) {
      _cacheRemoteVerificationForTest(`entry-${index}`);
    }
    expect(_remoteVerificationCacheSize()).toBe(500);
  });
});
