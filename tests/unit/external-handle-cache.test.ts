import { afterEach, describe, expect, it } from 'vitest';
import {
  _cacheExternalHandleMissForTest,
  _clearExternalHandleCache,
  _externalHandleCacheSize,
} from '../../src/identity/external-handle-resolver.js';

describe('external handle resolver cache', () => {
  afterEach(() => _clearExternalHandleCache());

  it('caps retained negative entries for unique handles', () => {
    for (let index = 0; index < 1001; index++) {
      _cacheExternalHandleMissForTest(`missing-${index}.example`);
    }
    expect(_externalHandleCacheSize()).toBe(1000);
  });
});
