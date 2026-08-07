import bcrypt from 'bcryptjs';

/**
 * Work factor for password hashing.
 *
 * `bcryptjs` is a pure-JS implementation, so a hash costs real event-loop time
 * rather than threadpool time: ~284ms to hash and ~276ms to verify at 12
 * rounds. That is the right price in production and the wrong one in a test
 * suite that creates hundreds of accounts, where it was a measurable share of
 * the per-file setup budget and contributed to `beforeAll` hooks timing out
 * under load (#222).
 *
 * So tests — and only tests — may lower it. The floor is enforced here rather
 * than trusted to configuration: outside `NODE_ENV=test` this is 12 whatever
 * the environment says, so a stray variable in a deployment cannot weaken
 * password hashing.
 */
const PRODUCTION_SALT_ROUNDS = 12;

function saltRounds(): number {
  if (process.env.NODE_ENV !== 'test') return PRODUCTION_SALT_ROUNDS;
  const configured = parseInt(process.env.TEST_BCRYPT_ROUNDS || '', 10);
  return Number.isInteger(configured) && configured >= 4 && configured <= PRODUCTION_SALT_ROUNDS
    ? configured
    : 4;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, saltRounds());
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
