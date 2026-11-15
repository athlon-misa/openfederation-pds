/**
 * SDK_VERSION is the published package's version. It comes from package.json
 * at build time (tsup `define`), so it cannot drift as it once did ('0.1.0'
 * while the package was 0.7.x).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SDK_VERSION } from '../../packages/openfederation-sdk/src/index.js';

describe('SDK_VERSION', () => {
  it('equals the version in packages/openfederation-sdk/package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../packages/openfederation-sdk/package.json'), 'utf8'));
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
