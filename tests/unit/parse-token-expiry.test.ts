import { describe, it, expect } from 'vitest';
import { parseTokenExpiry } from '../../packages/openfederation-sdk/src/utils.js';

// Covers the shapes OAuth SDKs actually return `expires_at` as, plus the
// failure modes that poison downstream freshness checks (NaN, seconds-
// mistaken-for-milliseconds). Validates the ≤1e12 heuristic cleanly
// disambiguates seconds from milliseconds.

describe('parseTokenExpiry', () => {
  describe('numbers', () => {
    it('accepts a milliseconds epoch as-is', () => {
      const ms = Date.parse('2026-04-21T15:00:00Z');
      expect(parseTokenExpiry(ms)).toBe(ms);
    });

    it('upconverts a seconds epoch to milliseconds', () => {
      const seconds = 1745251200;  // 2025-04-21T12:00:00Z
      expect(parseTokenExpiry(seconds)).toBe(seconds * 1000);
      // Must be in 2025, not 1970.
      expect(new Date(parseTokenExpiry(seconds)).getUTCFullYear()).toBe(2025);
    });

    it('treats an exact 1e12 boundary as milliseconds', () => {
      expect(parseTokenExpiry(1e12)).toBe(1e12);
    });

    it('treats anything just under 1e12 as seconds', () => {
      expect(parseTokenExpiry(1e12 - 1)).toBe((1e12 - 1) * 1000);
    });

    it('returns fallback for NaN or Infinity', () => {
      const fallback = 9_999_999;
      expect(parseTokenExpiry(NaN, { fallbackMs: fallback })).toBe(fallback);
      expect(parseTokenExpiry(Infinity, { fallbackMs: fallback })).toBe(fallback);
      expect(parseTokenExpiry(-Infinity, { fallbackMs: fallback })).toBe(fallback);
    });
  });

  describe('strings', () => {
    it('parses an ISO-8601 string', () => {
      expect(parseTokenExpiry('2026-04-21T15:00:00Z')).toBe(Date.parse('2026-04-21T15:00:00Z'));
    });

    it('parses a numeric string (seconds)', () => {
      expect(parseTokenExpiry('1745251200')).toBe(1745251200 * 1000);
    });

    it('parses a numeric string (milliseconds)', () => {
      const ms = Date.now();
      expect(parseTokenExpiry(String(ms))).toBe(ms);
    });

    it('returns fallback for an empty string', () => {
      const fallback = 123;
      expect(parseTokenExpiry('', { fallbackMs: fallback })).toBe(fallback);
    });

    it('returns fallback for garbage', () => {
      const fallback = 777;
      expect(parseTokenExpiry('not a date', { fallbackMs: fallback })).toBe(fallback);
    });
  });

  describe('other types', () => {
    it('accepts a Date instance', () => {
      const d = new Date('2026-04-21T15:00:00Z');
      expect(parseTokenExpiry(d)).toBe(d.getTime());
    });

    it('returns fallback for an invalid Date', () => {
      const fallback = 42;
      expect(parseTokenExpiry(new Date('not a date'), { fallbackMs: fallback })).toBe(fallback);
    });

    it('returns fallback for undefined / null / object', () => {
      const fb = 111;
      expect(parseTokenExpiry(undefined, { fallbackMs: fb })).toBe(fb);
      expect(parseTokenExpiry(null, { fallbackMs: fb })).toBe(fb);
      expect(parseTokenExpiry({}, { fallbackMs: fb })).toBe(fb);
      expect(parseTokenExpiry([], { fallbackMs: fb })).toBe(fb);
    });
  });

  describe('default fallback', () => {
    it('defaults to ~1 hour in the future when the value is garbage', () => {
      const before = Date.now();
      const result = parseTokenExpiry('garbage');
      const after = Date.now();
      // Should be within [before+1h, after+1h].
      expect(result).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
      expect(result).toBeLessThanOrEqual(after + 60 * 60 * 1000);
    });
  });

  describe('never returns NaN', () => {
    // The bug this helper exists to prevent: a NaN result.
    const pathological: unknown[] = [
      NaN, Infinity, -Infinity,
      undefined, null, '', 'nope',
      {}, [], new Date('invalid'),
      Symbol('x'), () => {},
    ];
    it.each(pathological)('returns a finite number for %p', (v) => {
      expect(Number.isFinite(parseTokenExpiry(v))).toBe(true);
    });
  });
});
