import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleEmail, maskEmail } from '../src/email.js';

test('accepts plain addresses, refuses the rest', () => {
  for (const ok of ['a@b.co', 'misa@weareathlon.com', 'first.last+tag@sub.example.org']) assert.equal(isPlausibleEmail(ok), true, ok);
  for (const bad of ['', 'nobody', '@example.com', 'a@b', 'a@b.', 'a@.com', 'a@@b.com', 'a@b@c.com', 'a b@c.com', `${'a'.repeat(250)}@b.co`]) {
    assert.equal(isPlausibleEmail(bad), false, bad);
  }
});

test('stays fast on hostile input (no backtracking)', () => {
  const start = Date.now();
  isPlausibleEmail('a@' + '!.'.repeat(100_000));
  assert.ok(Date.now() - start < 100);
});

test('masks the local part', () => {
  assert.equal(maskEmail('misa@weareathlon.com'), 'm•••@weareathlon.com');
  assert.equal(maskEmail('a@b.co'), 'a•@b.co');
});
