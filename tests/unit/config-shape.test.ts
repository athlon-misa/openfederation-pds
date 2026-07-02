import { describe, it, expect } from 'vitest';
import { config } from '../../src/config.js';

describe('config shape', () => {
  it('exposes rate limits with numeric defaults', () => {
    expect(config.rateLimits.authPer15Min).toBeTypeOf('number');
    expect(config.rateLimits.registrationPerHour).toBeTypeOf('number');
    expect(config.rateLimits.createPerHour).toBeTypeOf('number');
    expect(config.rateLimits.walletSignPerMin).toBeTypeOf('number');
    expect(config.rateLimits.serviceAuthPerMin).toBeTypeOf('number');
  });

  it('exposes env flags', () => {
    expect(config.env.nodeEnv).toBeTypeOf('string');
    expect(config.env.isProduction).toBeTypeOf('boolean');
  });

  it('exposes CORS origins as a non-empty array', () => {
    expect(Array.isArray(config.cors.origins)).toBe(true);
    expect(config.cors.origins.length).toBeGreaterThan(0);
  });

  it('exposes a PDS service DID', () => {
    expect(config.pds.serviceDid).toMatch(/^did:/);
  });
});
