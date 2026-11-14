/**
 * Which dashboard pages never load or refresh the person's session: the
 * signed-out pen-name pages (which also seal the tab) and /verify.
 */
import { describe, it, expect } from 'vitest';
import { isSessionFreePage, isSignedOutArea } from '../../web-interface/src/lib/signed-out-area.js';

describe('isSessionFreePage', () => {
  it('covers the pen-name pages and /verify', () => {
    for (const p of ['/pen-names', '/pen-names/new', '/verify', '/verify/']) expect(isSessionFreePage(p)).toBe(true);
  });

  it('leaves the dashboard and look-alike paths alone', () => {
    for (const p of ['/', '/dashboard', '/account/pen-names', '/verifyx', '/pen-namesx', null, undefined, '']) expect(isSessionFreePage(p)).toBe(false);
  });

  it('/verify does not seal the tab; the pen-name pages do', () => {
    expect(isSignedOutArea('/verify')).toBe(false);
    expect(isSignedOutArea('/pen-names/new')).toBe(true);
  });
});
