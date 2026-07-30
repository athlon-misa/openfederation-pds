import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPLCAvailable } from './helpers.js';

const originalCI = process.env.CI;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCI === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = originalCI;
  }
});

describe('isPLCAvailable', () => {
  it('fails CI runs when neither PLC health endpoint is reachable', async () => {
    process.env.CI = 'true';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('PLC unavailable')));

    await expect(isPLCAvailable()).rejects.toThrow('PLC directory is unavailable in CI');
  });
});
