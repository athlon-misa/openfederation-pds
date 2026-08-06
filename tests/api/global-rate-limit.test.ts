/**
 * The global rate limit is configurable, and the suite runs above it (#222).
 *
 * `globalLimiter` applies to every request and was fixed at 120/minute per IP
 * in code — the one limiter `tests/api/setup.ts` could not raise, though it
 * raises the other four for exactly this reason. Every test file drives the
 * same long-lived app from 127.0.0.1, so the suite exhausted that budget within
 * its first minute and whichever test was running when it ran out failed with a
 * 429. A different test each run; every one of them passing in isolation,
 * because one file alone stays under 120.
 *
 * This pins both halves: the ceiling is not hard-coded any more, and the suite
 * really does run above the production default rather than merely near it.
 */
import { describe, it, expect } from 'vitest';
import { xrpcGet } from './helpers.js';
import { config } from '../../src/config.js';

/** The production default, and the value the suite used to be capped at. */
const DEFAULT_GLOBAL_LIMIT = 120;

describe('global rate limit (#222)', () => {
  it('takes its ceiling from the environment', () => {
    // A hard-coded `max:` would put this back exactly as it was, and nothing
    // else in the suite would notice until a test started failing at random.
    expect(config.rateLimits.globalPerMin).toBe(Number(process.env.GLOBAL_RATE_LIMIT));
    expect(config.rateLimits.globalPerMin).toBeGreaterThan(DEFAULT_GLOBAL_LIMIT);
  });

  it('lets the suite exceed the production default without a 429', async () => {
    // Deliberately more than 120 in one burst: this is the shape of traffic
    // that used to fail, and it fails again the moment the ceiling stops being
    // configurable.
    const statuses = new Set<number>();
    for (let i = 0; i < DEFAULT_GLOBAL_LIMIT + 30; i++) {
      const res = await xrpcGet('com.atproto.server.describeServer', {});
      statuses.add(res.status);
    }
    expect([...statuses]).not.toContain(429);
  }, 120_000);
});
