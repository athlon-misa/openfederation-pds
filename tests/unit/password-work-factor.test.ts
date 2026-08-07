/**
 * The password work factor is lowered for tests, and *only* for tests (#222).
 *
 * `bcryptjs` is pure JS, so 12 rounds costs ~284ms of event-loop time to hash
 * and ~276ms to verify. A suite that creates hundreds of accounts spent a
 * meaningful share of its per-file setup budget there, which is part of why
 * `beforeAll` hooks timed out under load.
 *
 * Lowering it is safe for tests and unsafe for anything else, so the floor is
 * enforced in code rather than left to configuration. That is the property
 * worth a test: a stray `TEST_BCRYPT_ROUNDS` in a deployment must not weaken
 * password hashing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

const PRODUCTION_ROUNDS = 12;

/** bcrypt encodes its cost in the hash: `$2a$<cost>$…`. */
function costOf(hash: string): number {
  return Number(hash.split('$')[2]);
}

describe('password work factor', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalRounds = process.env.TEST_BCRYPT_ROUNDS;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalRounds === undefined) delete process.env.TEST_BCRYPT_ROUNDS;
    else process.env.TEST_BCRYPT_ROUNDS = originalRounds;
  });

  it('hashes cheaply under test, and the hash still verifies', async () => {
    process.env.NODE_ENV = 'test';
    const hash = await hashPassword('correct horse battery staple');

    expect(costOf(hash)).toBeLessThan(PRODUCTION_ROUNDS);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('ignores the override outside NODE_ENV=test', async () => {
    // The failure this exists to prevent: a variable left in a deployment
    // quietly dropping production hashing to 4 rounds.
    process.env.NODE_ENV = 'production';
    process.env.TEST_BCRYPT_ROUNDS = '4';

    const hash = await hashPassword('correct horse battery staple');
    expect(costOf(hash)).toBe(PRODUCTION_ROUNDS);
  });

  it('refuses a work factor below the floor even under test', async () => {
    process.env.NODE_ENV = 'test';
    process.env.TEST_BCRYPT_ROUNDS = '1';

    const hash = await hashPassword('correct horse battery staple');
    expect(costOf(hash)).toBeGreaterThanOrEqual(4);
  });

  it('verifies hashes written at the production cost', async () => {
    // Existing accounts carry 12-round hashes; lowering the cost for new ones
    // must not stop old ones logging in.
    process.env.NODE_ENV = 'test';
    const legacy = bcrypt.hashSync('correct horse battery staple', PRODUCTION_ROUNDS);

    expect(costOf(legacy)).toBe(PRODUCTION_ROUNDS);
    expect(await verifyPassword('correct horse battery staple', legacy)).toBe(true);
  });
});
