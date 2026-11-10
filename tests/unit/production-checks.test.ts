/**
 * Production start-up rules that are easy to get wrong silently:
 *  - without OAUTH_SIGNING_KEY the OAuth key changes on every restart (every
 *    token is invalidated, and two instances disagree), so production refuses
 *    to start, like it does for the other secrets;
 *  - without REDIS_URL, OAuth replay protection is per instance;
 *  - with DB_SSL off, database traffic is clear text unless the database is on
 *    this machine or a private platform network (".internal").
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { JoseKey } from '@atproto/oauth-provider';
import { productionConfigProblems, OAUTH_KEY_COMMAND } from '../../src/server/production-checks.js';

const base = {
  isProduction: true,
  oauth: { enabled: true, signingKey: '{"kty":"EC"}', redisUrl: 'redis://r' },
  database: { ssl: true, host: 'db.example.com' },
};
const run = (patch: Record<string, any> = {}) => productionConfigProblems({
  ...base, ...patch,
  oauth: { ...base.oauth, ...(patch.oauth ?? {}) },
  database: { ...base.database, ...(patch.database ?? {}) },
});

describe('production start-up checks', () => {
  it('a complete production configuration has no problems', () => {
    expect(run()).toEqual({ fatal: [], warnings: [] });
  });

  it('refuses to start without an OAuth signing key', () => {
    const { fatal } = run({ oauth: { signingKey: '' } });
    expect(fatal.join('\n')).toContain('OAUTH_SIGNING_KEY');
  });

  it('needs no OAuth key when OAuth is switched off', () => {
    expect(run({ oauth: { enabled: false, signingKey: '', redisUrl: '' } }).fatal).toEqual([]);
  });

  it('warns that replay protection is per instance without Redis', () => {
    const { fatal, warnings } = run({ oauth: { redisUrl: '' } });
    expect(fatal).toEqual([]);
    expect(warnings.join('\n')).toContain('REDIS_URL');
  });

  it('warns when the database connection is not encrypted and leaves this machine', () => {
    expect(run({ database: { ssl: false, host: 'db.example.com' } }).warnings.join('\n')).toContain('DB_SSL');
  });

  it('does not warn about database TLS for a local or platform-internal database', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', 'postgres.railway.internal', 'db.internal']) {
      expect(run({ database: { ssl: false, host } }).warnings).toEqual([]);
    }
  });

  it('checks nothing outside production', () => {
    expect(run({ isProduction: false, oauth: { signingKey: '', redisUrl: '' }, database: { ssl: false } }))
      .toEqual({ fatal: [], warnings: [] });
  });

  it('the suggested command produces a key the OAuth provider accepts', async () => {
    const [cmd, ...args] = OAUTH_KEY_COMMAND;
    const jwk = execFileSync(cmd, args, { encoding: 'utf8' }).trim();
    const key = await JoseKey.fromJWK(jwk);
    expect(key.algorithms).toContain('ES256');
    expect(key.isPrivate).toBe(true);
  });
});
