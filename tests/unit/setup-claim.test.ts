/**
 * Claiming a fresh install with the setup code from the log (#405).
 */
import { describe, it, expect } from 'vitest';
import {
  ClaimGuard, generateSetupCode, normalizeSetupCode, MAX_FAILURES_PER_ADDRESS, MAX_FAILURES_PER_CODE, SESSION_IDLE_MS, ADDRESS_WINDOW_MS,
} from '../../src/setup/claim.js';

function guard(now = { t: 1_000_000 }) {
  const codes: string[] = [];
  const g = new ClaimGuard({ announce: (c) => codes.push(c), now: () => now.t });
  return { g, codes, now };
}

describe('setup code', () => {
  it('is 20 unambiguous characters in four groups, different each time', () => {
    const a = generateSetupCode();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(generateSetupCode()).not.toBe(a);
  });

  it('is announced once at start, and ignores case, spaces and dashes when typed', () => {
    const { g, codes } = guard();
    expect(codes).toHaveLength(1);
    const typed = ` ${codes[0].toLowerCase().replace(/-/g, ' ')} `;
    expect(normalizeSetupCode(typed)).toBe(codes[0].replace(/-/g, ''));
    expect(g.claim(typed, '1.2.3.4').ok).toBe(true);
  });
});

describe('ClaimGuard', () => {
  it('a wrong code opens nothing; the right one opens a session', () => {
    const { g, codes } = guard();
    expect(g.claim('AAAAA-AAAAA-AAAAA-AAAAA', 'x')).toEqual({ ok: false, reason: 'wrong-code' });
    expect(g.claim('', 'x').ok).toBe(false);
    expect(g.claim('A'.repeat(500), 'x').ok).toBe(false);
    const r = g.claim(codes[0], 'x');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sessionId).toMatch(/^[0-9a-f]{64}$/);
      expect(g.hasSession(r.sessionId)).toBe(true);
    }
    expect(g.hasSession('nope')).toBe(false);
    expect(g.hasSession(undefined)).toBe(false);
  });

  it('limits wrong guesses per address, even for the right code, until the window passes', () => {
    const { g, codes, now } = guard();
    for (let i = 0; i < MAX_FAILURES_PER_ADDRESS; i++) g.claim('WRONG', 'attacker');
    expect(g.claim(codes[0], 'attacker')).toMatchObject({ ok: false, reason: 'too-many-attempts' });
    expect(g.claim(codes[0], 'someone-else').ok).toBe(true);
    now.t += ADDRESS_WINDOW_MS + 1;
    expect(g.claim(codes[0], 'attacker').ok).toBe(true);
  });

  it('replaces the code after too many wrong guesses in total, and announces the new one', () => {
    const { g, codes } = guard();
    for (let i = 0; i < MAX_FAILURES_PER_CODE; i++) g.claim('WRONG', `addr-${i}`);
    expect(codes).toHaveLength(2);
    expect(g.claim(codes[0], 'fresh').ok).toBe(false);
    expect(g.claim(codes[1], 'fresh2').ok).toBe(true);
  });

  it('sessions end after two idle hours; use keeps them alive', () => {
    const { g, codes, now } = guard();
    const r = g.claim(codes[0], 'x');
    if (!r.ok) throw new Error('claim failed');
    now.t += SESSION_IDLE_MS - 1000;
    expect(g.hasSession(r.sessionId)).toBe(true);
    now.t += SESSION_IDLE_MS - 1000;
    expect(g.hasSession(r.sessionId)).toBe(true);
    now.t += SESSION_IDLE_MS + 1;
    expect(g.hasSession(r.sessionId)).toBe(false);
  });

  it('once locked, no session and no code opens it again', () => {
    const { g, codes } = guard();
    const r = g.claim(codes[0], 'x');
    if (!r.ok) throw new Error('claim failed');
    g.lock();
    expect(g.hasSession(r.sessionId)).toBe(false);
    expect(g.claim(codes[0], 'y').ok).toBe(false);
    for (let i = 0; i < MAX_FAILURES_PER_CODE + 5; i++) g.claim('WRONG', `a${i}`);
    expect(codes).toHaveLength(1); // locked: no new code is ever announced
  });
});
